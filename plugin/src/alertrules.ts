/**
 * Which conditions are allowed to raise the flag, and the proof that says who asked.
 *
 * This is the one thing a device writes to a boat, and it is set apart from every other
 * message on the socket for a reason that is worth stating plainly: everything else is a
 * read. A read needs no proof of the asker, because the answer is sealed to the owner's
 * screens either way - a stranger who seals a question learns nothing from a reply he cannot
 * open. A write has no such shape. The boat's inbox key is public by design, so a write
 * accepted on the same terms would let anybody who knows it silence an owner's alarms, and he
 * would find out the next time something went wrong and his phone stayed quiet.
 *
 * The proof creates no new credential. It is made with the X25519 private half the device
 * already holds to open her frames: whoever has that key is reading every report she sends,
 * so there is no fresh secret here for anyone to steal.
 *
 * What the rules do, and what they deliberately do not: they filter the flag, not the report.
 * A muted condition is still in the sealed body and still on the screen of anybody who opens
 * the app. The owner asked not to be woken, not to be kept in the dark.
 *
 * Read-only, like everything else aboard: the list is written to the plugin's own data
 * directory, the same way the voyage log is. Nothing here reaches Signal K, emits a delta or
 * moves any equipment.
 */
import { createHmac, diffieHellman, hkdfSync, timingSafeEqual } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import type { AlertLevel, AlertRing, AlertRule } from './contract'
import {
  lp,
  strictDecode,
  u16be,
  u32be,
  u64be,
  x25519PrivateFromRaw,
  x25519PublicFromRaw
} from './sealing'

/** Domain separation, so a key derived here can collide with none derived elsewhere. */
const PROOF_INFO = 'siparu/rule-proof/v1'
const PROOF_PREFIX = 'siparu/rule-proof/v1'

const PROOF_BYTES = 32
const KEY_BYTES = 32

export const RULES_VERSION = 1

/**
 * The most rules one boat will hold.
 *
 * A vessel raising more distinct notification paths than this is not a vessel whose owner is
 * curating them one by one, and the list is written to a flash card that has other work to do.
 * Well past the tank, engine and generator notifications a real boat carries.
 */
export const MAX_ALERT_RULES = 128

/** The longest notification path a rule may name. Signal K's own are far shorter. */
export const MAX_RULE_PATH = 256

/**
 * How far ahead of the boat's own clock a list may be stamped.
 *
 * A phone and a boat disagree by seconds, not minutes, and the window exists so a device with
 * a badly set clock cannot stamp a list in the next century and lock its owner out of every
 * edit after it.
 */
export const MAX_CLOCK_SKEW_MS = 5 * 60_000

/** The prefix that makes a path a notification rather than a gauge. */
const NOTIFICATIONS_PREFIX = 'notifications.'

/**
 * The floor a condition has to reach to be heard, for the two rings that are a severity.
 *
 * `never` is deliberately absent, and the absence is load-bearing: it is not a louder
 * severity, it is the refusal of all of them, exactly as `normal` is not a quiet alert but
 * the lack of one. Giving it a rank of three would work by arithmetic and leave the explicit
 * check below unmeasurable - removing that check would change nothing, which is the shape of a
 * guard that has stopped guarding. This way the compiler refuses the version without it.
 */
const RING_FLOOR: Readonly<Record<Exclude<AlertRing, 'never'>, number>> = { warning: 1, alarm: 2 }
const LEVEL_RANK: Readonly<Record<Exclude<AlertLevel, 'normal'>, number>> = { warning: 1, alarm: 2 }

/**
 * What a boat with no rules does, and therefore what she does about a path nobody has named:
 * everything rings. A default of anything else would mean a feature nobody switched on could
 * silence an alarm, which is the one mistake this file must not make.
 */
export const DEFAULT_RING: AlertRing = 'warning'

/**
 * A rule list as it arrives, parsed only as far as the proof needs it.
 *
 * Deliberately not validated here beyond "these are the right kinds of thing". The proof is
 * computed over raw fields, so whether `ring_from` is a word this build knows is a question
 * for after the sender has been established - a device sending a list this build cannot use
 * deserves an answer saying so, and a stranger deserves nothing at all.
 */
export interface ParsedRuleWrite {
  v: number
  id: string
  kid: string
  ts: number
  rules: { path: string; ring_from: string }[]
  proof: string
}

/**
 * The exact bytes both implementations compute the proof over.
 *
 * Built from raw fields with explicit lengths rather than from re-serialised JSON, exactly as
 * the frame signing input is, and for the same reason: the two implementations that have to
 * agree on these bytes are written in different languages, and any disagreement between their
 * JSON encoders about key order or spacing would refuse every write in the fleet at once.
 *
 * The rules are covered in the order they were sent rather than sorted, so a carrier that
 * reordered them fails the check. That order is also the order the boat stores them in, so
 * nothing has to be re-derived to verify the same list twice.
 */
export function proofInput(req: {
  v: number
  boat: string
  kid: string
  id: string
  ts: number
  rules: readonly { path: string; ring_from: string }[]
}): Buffer {
  const parts: Buffer[] = [
    Buffer.from(PROOF_PREFIX, 'utf8'),
    u16be(req.v),
    lp(Buffer.from(req.boat, 'utf8')),
    lp(Buffer.from(req.kid, 'utf8')),
    lp(Buffer.from(req.id, 'utf8')),
    u64be(req.ts),
    u32be(req.rules.length)
  ]
  for (const rule of req.rules) {
    parts.push(lp(Buffer.from(rule.path, 'utf8')), lp(Buffer.from(rule.ring_from, 'utf8')))
  }
  return Buffer.concat(parts)
}

/**
 * The key the sending device and the boat both arrive at, from opposite ends of one agreement.
 *
 * The device computes X25519(device_priv, inbox_pub); the boat computes
 * X25519(inbox_priv, device_pub). Salted with the device's public key and bound to the boat,
 * the device and the request, so a proof lifted off one write cannot be attached to another.
 */
function proofKey(shared: Buffer, devicePub: Buffer, boat: string, kid: string, id: string): Buffer {
  const info = Buffer.from(`${PROOF_INFO}/${boat}/${kid}/${id}`, 'utf8')
  return Buffer.from(hkdfSync('sha256', shared, devicePub, info, KEY_BYTES))
}

/**
 * Make the proof for one rule list. The device's side of the same agreement.
 *
 * Kept beside the check for the same reason `sealRequest` is kept beside `openRequest`: this
 * file is where the format lives, and both ends have to agree on it byte for byte. The
 * shipping client is the phone, in another language, held to the same committed vectors.
 */
export function makeRuleProof(opts: {
  req: Omit<ParsedRuleWrite, 'proof'>
  boat: string
  /** The device's raw 32-byte X25519 private half, and the public one it implies. */
  devicePriv: Buffer
  devicePub: Buffer
  /** The boat's raw 32-byte X25519 inbox public key. */
  inboxPub: Buffer
}): string {
  const shared = diffieHellman({
    privateKey: x25519PrivateFromRaw(opts.devicePriv, opts.devicePub),
    publicKey: x25519PublicFromRaw(opts.inboxPub)
  })
  const key = proofKey(shared, opts.devicePub, opts.boat, opts.req.kid, opts.req.id)
  return createHmac('sha256', key)
    .update(proofInput({ ...opts.req, boat: opts.boat }))
    .digest('base64url')
}

/**
 * Whether this write was made by the device it claims to be from.
 *
 * Returns false rather than throwing on anything malformed. This runs on whatever arrives over
 * a socket, and "this is not a write from a device I know" is an answer rather than a fault:
 * the two are the same thing to the caller, and only one of them is safe inside a live link.
 */
export function verifyRuleProof(opts: {
  req: ParsedRuleWrite
  boat: string
  /** The boat's raw 32-byte X25519 inbox private half, and the public one it implies. */
  inboxPriv: Buffer
  inboxPub: Buffer
  /** The raw 32-byte X25519 public key of the device named by `req.kid`. */
  devicePub: Buffer
}): boolean {
  try {
    const offered = strictDecode(opts.req.proof, PROOF_BYTES)
    if (opts.devicePub.length !== KEY_BYTES) return false
    const shared = diffieHellman({
      privateKey: x25519PrivateFromRaw(opts.inboxPriv, opts.inboxPub),
      publicKey: x25519PublicFromRaw(opts.devicePub)
    })
    const key = proofKey(shared, opts.devicePub, opts.boat, opts.req.kid, opts.req.id)
    const expected = createHmac('sha256', key)
      .update(proofInput({ ...opts.req, boat: opts.boat }))
      .digest()
    // Constant time, because the alternative leaks how much of a guess was right, one byte at
    // a time, to a party who may retry as often as he likes.
    return offered.length === expected.length && timingSafeEqual(offered, expected)
  } catch {
    return false
  }
}

/**
 * A rule write off the wire, parsed no further than the proof needs.
 *
 * Anything that is not shaped like one at all yields nothing, and the caller drops it in
 * silence, exactly as it drops every other message that is not its own request.
 */
export function parseRuleWrite(msg: unknown): ParsedRuleWrite | undefined {
  if (typeof msg !== 'object' || msg === null) return undefined
  const o = msg as Record<string, unknown>
  if (o.type !== 'setalertrules') return undefined
  if (typeof o.v !== 'number' || !Number.isInteger(o.v) || o.v < 0 || o.v > 0xffff) return undefined
  if (typeof o.id !== 'string' || o.id.length === 0 || o.id.length > 128) return undefined
  if (typeof o.kid !== 'string' || o.kid.length === 0 || o.kid.length > 64) return undefined
  if (typeof o.ts !== 'number' || !Number.isInteger(o.ts) || o.ts < 0) return undefined
  if (typeof o.proof !== 'string') return undefined
  if (!Array.isArray(o.rules)) return undefined
  // The ceiling is applied here as well as in the policy check below, because everything on
  // this side of the proof runs for anybody who can reach the socket: a list of a million
  // entries must not be hashed before it is refused.
  if (o.rules.length > MAX_ALERT_RULES) return undefined
  const rules: { path: string; ring_from: string }[] = []
  for (const entry of o.rules) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const { path: p, ring_from: r } = entry as { path?: unknown; ring_from?: unknown }
    if (typeof p !== 'string' || typeof r !== 'string') return undefined
    if (p.length > MAX_RULE_PATH || r.length > 32) return undefined
    rules.push({ path: p, ring_from: r })
  }
  return { v: o.v, id: o.id, kid: o.kid, ts: o.ts, rules, proof: o.proof }
}

/** Why a list this boat could not use was refused. Only ever told to a proven device. */
export type RuleRefusal =
  | { code: 'UNSUPPORTED_VERSION'; message: string }
  | { code: 'BAD_RULES'; message: string }
  | { code: 'STALE'; message: string }
  | { code: 'WRITE_FAILED'; message: string }

/**
 * The rules this boat is going by, and the file they survive a restart in.
 *
 * Held in the plugin's data directory rather than in its options, for the same reason the
 * keys are: Signal K serves plugin options wholesale over GET /plugins/<id>/config, and with
 * security off - the default install - that answers anyone on the boat's network. A list of
 * what an owner has chosen not to be told about is not something to hand out on a marina wifi.
 */
export class AlertRuleStore {
  private readonly file: string
  private byPath = new Map<string, AlertRing>()
  private order: AlertRule[] = []
  private appliedTs = 0
  /** One write at a time. See {@link apply} - this is the replay floor, not tidiness. */
  private queue: Promise<void> = Promise.resolve()

  constructor(
    dataDir: string,
    private readonly debug: (msg: string) => void = () => {}
  ) {
    this.file = path.join(dataDir, 'alertrules.json')
  }

  /**
   * Read the stored list, if there is one.
   *
   * A file that cannot be read or understood leaves the boat with no rules, which is the loud
   * side: every condition rings. The quiet side would have been a boat silently muted by a
   * corrupt file, and nobody would notice until the night it mattered.
   */
  load(): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      return
    }
    const raw = (parsed ?? {}) as { v?: unknown; ts?: unknown; rules?: unknown }
    if (raw.v !== RULES_VERSION || typeof raw.ts !== 'number' || !Array.isArray(raw.rules)) {
      this.debug('alert rules: stored list is not one this build understands, ignoring it')
      return
    }
    // Held to the same shape checks as a list off the wire, by handing it to the same parser
    // wearing the envelope fields it does not have. A second copy of those checks written for
    // the disk is a second thing to keep in step, and the one that drifted would be the one
    // nobody ran: a file this boat wrote yesterday is exactly the input least likely to be
    // suspected. The id and kid below are placeholders and are never read again - no proof is
    // checked here, because the proof was checked when the list arrived.
    const parsedRules = parseRuleWrite({
      type: 'setalertrules',
      v: RULES_VERSION,
      id: 'stored',
      kid: 'stored',
      ts: raw.ts,
      proof: '',
      rules: raw.rules
    })
    if (!parsedRules) {
      this.debug('alert rules: stored list is malformed, ignoring it')
      return
    }
    const checked = checkRules(parsedRules.rules)
    if ('error' in checked) {
      this.debug(`alert rules: stored list refused - ${checked.error.message}`)
      return
    }
    this.adopt(checked.rules, raw.ts)
  }

  /** The list in force, in the order it was written. */
  rules(): AlertRule[] {
    return this.order.map((r) => ({ ...r }))
  }

  /** Epoch ms of the list in force. Zero on a boat that has never been given one. */
  ts(): number {
    return this.appliedTs
  }

  /**
   * Whether one standing condition is allowed to raise the flag.
   *
   * A path nobody has named rings, and so does a boat with no list at all: the flag is what
   * reaches a pocket, and a silence chosen by nobody is the one outcome worth protecting
   * against.
   */
  rings(conditionPath: string, state: Exclude<AlertLevel, 'normal'>): boolean {
    const ring = this.byPath.get(conditionPath) ?? DEFAULT_RING
    if (ring === 'never') return false
    return LEVEL_RANK[state] >= RING_FLOOR[ring]
  }

  /**
   * Take a list from a device whose proof has already been checked.
   *
   * Runs one at a time, and the queue is not housekeeping - it is what makes the replay floor
   * mean anything. The floor is a check against `appliedTs` followed by a disk write, and a
   * disk write yields. Two writes arriving together would both read the floor before either
   * raised it, both pass, and land in whatever order the filesystem finished them: a carrier
   * holding an old sealed write only has to deliver it alongside a new one to have the old
   * list win AND drag `appliedTs` backwards, which reopens every write it captured since.
   * Serialising here is the whole of the fix; nothing below may assume it runs alone.
   */
  async apply(req: ParsedRuleWrite, now: number): Promise<RuleRefusal | undefined> {
    const run = (): Promise<RuleRefusal | undefined> => this.applyAlone(req, now)
    const next = this.queue.then(run, run)
    // The queue must not inherit a rejection, or one failure would poison every later write.
    this.queue = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  private async applyAlone(req: ParsedRuleWrite, now: number): Promise<RuleRefusal | undefined> {
    if (req.v !== RULES_VERSION) {
      return {
        code: 'UNSUPPORTED_VERSION',
        message: 'This boat is running an older Siparu than this app expects. Update the plugin.'
      }
    }
    const checked = checkRules(req.rules)
    if ('error' in checked) return checked.error

    if (req.ts <= this.appliedTs) {
      return {
        code: 'STALE',
        message: 'She is already going by a newer list than this one.'
      }
    }
    if (req.ts > now + MAX_CLOCK_SKEW_MS) {
      return {
        code: 'STALE',
        message: "This device's clock is ahead of the boat's. Check the time and try again."
      }
    }

    try {
      await this.persist({ v: RULES_VERSION, ts: req.ts, rules: checked.rules })
    } catch (e) {
      this.debug(`alert rules: could not write the list - ${String(e)}`)
      return {
        code: 'WRITE_FAILED',
        message: 'She could not save the list. Her storage may be full or read-only.'
      }
    }
    this.adopt(checked.rules, req.ts)
    return undefined
  }

  /** Wait for a queued write to land, so a stop does not return with a rename in flight. */
  flush(): Promise<void> {
    return this.queue.then(() => undefined)
  }

  private adopt(rules: AlertRule[], ts: number): void {
    this.order = rules
    this.byPath = new Map(rules.map((r) => [r.path, r.ring_from]))
    this.appliedTs = ts
  }

  /** Callers reach this through the queue above, so it needs no chain of its own. */
  private async persist(shape: { v: number; ts: number; rules: AlertRule[] }): Promise<void> {
    const tmp = `${this.file}.tmp`
    // 0600 and write-then-rename, like every other file the plugin keeps for itself. The list
    // is not a secret the way a key is, but a boat losing power mid-write must not come back
    // going by half a list, and there is no reason for the rest of the machine to read what
    // her owner chose not to be told about.
    await fs.promises.writeFile(tmp, JSON.stringify(shape), { mode: 0o600 })
    await fs.promises.rename(tmp, this.file)
  }
}

/**
 * Whether a parsed list is one this boat can act on.
 *
 * Run after the proof rather than before it, so that a device this boat answers to gets told
 * what was wrong with its list, and a stranger gets nothing: the shape checks a proof needs
 * are in {@link parseRuleWrite}, and these are the ones about meaning.
 */
function checkRules(
  raw: readonly { path: string; ring_from: string }[]
): { rules: AlertRule[] } | { error: RuleRefusal } {
  if (raw.length > MAX_ALERT_RULES) {
    return {
      error: { code: 'BAD_RULES', message: `A boat holds at most ${MAX_ALERT_RULES} rules.` }
    }
  }
  const seen = new Set<string>()
  const rules: AlertRule[] = []
  for (const entry of raw) {
    if (!entry.path.startsWith(NOTIFICATIONS_PREFIX)) {
      return {
        error: { code: 'BAD_RULES', message: 'A rule names a notification path, and that one does not.' }
      }
    }
    // Two rules for one path have no answer that is not a guess about which the owner meant,
    // and guessing wrong here is a silence he did not ask for.
    if (seen.has(entry.path)) {
      return { error: { code: 'BAD_RULES', message: 'The same path appears twice in this list.' } }
    }
    if (!isRing(entry.ring_from)) {
      return {
        error: {
          code: 'BAD_RULES',
          message: `This boat does not know what "${entry.ring_from}" means.`
        }
      }
    }
    seen.add(entry.path)
    rules.push({ path: entry.path, ring_from: entry.ring_from })
  }
  return { rules }
}

function isRing(value: string): value is AlertRing {
  return value === 'warning' || value === 'alarm' || value === 'never'
}
