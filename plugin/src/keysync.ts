/**
 * The boat telling the shore who she is.
 *
 * Her identity key signs every sealed frame and her inbox key receives what a device
 * seals back to her, and neither is any use to anybody until the public halves are
 * somewhere a phone can fetch them. That somewhere is the account, reached through
 * the relay, authenticated by the token she already holds.
 *
 * Two rules shape everything below.
 *
 * The keys are made only once she is PAIRED. An unpaired vessel has nobody to talk
 * to, and a key pair generated on a machine that is only ever going to run the local
 * dashboard is a credential created for no reason (the specification says the same:
 * created at first pairing, kept for life).
 *
 * Publishing is write-once ashore, so it does not matter how often she says it: the
 * same pair is not a change and the shore answers 'ok' either way. She therefore keeps
 * no memory across a restart of whether it landed.
 *
 * The same call answers the other question she needs asked continuously - which screens
 * her owner has authorised - so the two share a poll rather than each having their own.
 * A device added ashore starts receiving within one interval, and a device removed stops
 * within one, which is what revocation means in practice.
 *
 * Read-only, like everything else here: this talks outbound to the relay and never to
 * Signal K. Nothing in this file emits a delta or a PUT.
 */
import type { DevicePublicKey } from './contract'
import type { BoatKeyStore } from './keystore'
import type { SealingLatchStore } from './latch'
import type { RemoteLink } from './remotelink'
import { MAX_DEVICES } from './sealing'

export type KeySyncState =
  /** Not paired, or not tried yet. */
  | 'idle'
  /** The shore holds her keys. Nothing more to do until she is paired again. */
  | 'published'
  /**
   * The shore holds DIFFERENT keys for this boat, and refused to replace them.
   *
   * Not a transient error and not retried. It means this vessel's row ashore was
   * published by another copy of her - a restored SD card, a cloned virtual machine -
   * or that her own keys.json was lost and rebuilt. Devices recognise her by the keys
   * ashore, so sealed reporting cannot work until she is unlinked and paired again.
   */
  | 'mismatch'
  /** The relay did not answer, or refused. She keeps trying. */
  | 'failing'

export interface KeySyncStatus {
  state: KeySyncState
  /** In words a skipper can act on, null while nothing is wrong. */
  lastError: string | null
  /** How many screens the shore says may read her. Zero until her owner adds one. */
  devices: number
  /**
   * Whether cleartext is over for this vessel. With `devices` at zero it means she is
   * sending nothing at all, which is the one state that looks from ashore exactly like a
   * boat that has lost her connection.
   */
  sealing: boolean
}

export interface KeySyncDeps {
  relayUrl: string
  getRemote: () => RemoteLink | undefined
  keys: BoatKeyStore
  /** Where the promise not to go back to cleartext survives a restart. */
  latch: SealingLatchStore
  debug: (msg: string) => void
  /** Retry interval. Minutes in production; tests need it shorter. */
  intervalMs?: number
}

/**
 * How often she asks.
 *
 * Five minutes is the cost of adding a screen: a device her owner authorises ashore starts
 * receiving within one interval, and one he removes stops within one. Faster would buy him
 * seconds on an errand he runs once a year, and cost every boat in the fleet a request every
 * time. Slower would make revocation feel broken.
 */
const DEFAULT_INTERVAL_MS = 5 * 60_000
const REQUEST_TIMEOUT_MS = 20_000
const MAX_BACKOFF_MS = 30 * 60_000

/**
 * The closest together two asks may be when something ashore prompts them.
 *
 * The five minutes above is the cost of adding a screen when nobody is waiting. Somebody
 * watching is the one moment that cost is paid by a person rather than by a timer, and it is
 * exactly then that a phone authorised a minute ago sits in front of an owner showing nothing:
 * she is sealing to a list that does not name it yet. So she asks again when a screen opens.
 *
 * The floor is what keeps that from being a lever. Opening a socket is cheap for whoever does
 * it and an ask is not free for her - it is a request over whatever link she has, which for
 * most of the fleet is metered satellite - so a screen reconnecting in a loop must not be able
 * to turn into a boat asking in a loop. Half a minute puts the worst case at twice a minute
 * and leaves the good case, one owner opening his phone, indistinguishable from instant.
 */
export const PROMPTED_FLOOR_MS = 30_000

export class KeySync {
  private timer: NodeJS.Timeout | null = null
  private inFlight: AbortController | null = null
  private readonly intervalMs: number
  private stopped = false
  private failures = 0
  private state: KeySyncState = 'idle'
  private lastError: string | null = null
  private published = false
  private deviceList: DevicePublicKey[] = []
  /** Whether the shore has ever named a screen for this boat. Never unset by the shore. */
  private latched = false
  /** Whether that has reached the disk, so a start after a restart knows it too. */
  private persisted = false
  /**
   * Which poll's answer is still wanted.
   *
   * An unpairing can land while a request is in the air, and the answer that comes back
   * belongs to the account she has just left: applied, it would hand the old owner's screens
   * back to a boat that now belongs to somebody else, and re-arm a promise made to them.
   * Aborting the request is not enough on its own - it does not cover the moment between the
   * body arriving and being read.
   */
  private generation = 0
  /**
   * When she last put the question to the shore, whatever came back. Null before the first.
   *
   * Stamped when the request goes out rather than when it returns, because what it meters is
   * how often she may speak, and a request that timed out after twenty seconds cost her the
   * same link time as one that was answered.
   */
  private lastPollAt: number | null = null

  constructor(private readonly deps: KeySyncDeps) {
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
  }

  start(): void {
    if (this.timer) return
    this.stopped = false
    // Whether she was sealing when she was last shut down. Signal K restarts a plugin on
    // every config save, and without this each of those restarts was a boat that had been
    // sealing a moment earlier reporting her position in the clear until the shore answered.
    this.latched = this.deps.latch.load(this.deps.getRemote()?.boatId)
    this.persisted = this.latched
    // Asked at once, not after the first interval. Until the shore has answered, she does not
    // know she has any screens to seal to and reports in the clear - so an interval's wait is
    // an interval of cleartext frames, position included, from a boat that was sealing a
    // moment earlier. Signal K restarts a plugin on every config save, which made that window
    // routine rather than rare.
    this.schedule(0)
  }

  /**
   * Ask now, because somebody ashore has just opened a screen.
   *
   * She would have asked anyway; this only moves the next one forward, and it moves nothing
   * else. It answers the gap between a phone being authorised on the account and this vessel
   * reading that it was: five minutes of a screen its owner has just sealed showing nothing,
   * with a boat behind it reporting perfectly well every couple of seconds.
   *
   * One that comes too soon is HELD to the floor rather than dropped, and the difference is a
   * whole owner's evening. Dropped, the second of two screens authorised in the same minute -
   * a phone and the tablet beside it - falls back on the five minute poll and shows nothing
   * while the first one works, which is the fault this exists to close, arriving by a
   * different road. Measured live on 2 Aug: a second screen a minute behind the first waited
   * out the whole interval. Held, it costs at most one ask per floor either way.
   *
   * Dropped, though, when a poll is already in the air: its answer is newer than this prompt,
   * so there is nothing to add. And while she is failing the backoff governs instead, because
   * a screen reconnecting cannot fix a relay that is not answering, and asking on its schedule
   * rather than on hers is how a boat with no uplink knocks all night.
   *
   * Nothing that arrives from outside reaches this except the fact that it happened. What is
   * asked, who it is asked of and what is done with the answer are all decided in `poll`,
   * exactly as they are on the timer.
   */
  prompt(now = Date.now()): void {
    if (this.stopped) return
    // One already in the air is the answer to this. Its result is newer than this prompt.
    if (this.inFlight) return
    if (this.failures > 0) return
    const wait = this.lastPollAt === null ? 0 : this.lastPollAt + PROMPTED_FLOOR_MS - now
    if (wait > 0) {
      // Brought forward to the floor and no further. The ordinary interval is minutes away, so
      // this is always the sooner of the two; a prompt arriving again in the meantime lands on
      // the same instant rather than adding another.
      this.schedule(wait)
      return
    }
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    // tick() reschedules on its own, so the ordinary interval survives this: a prompt shifts
    // the next ask, it does not replace the poll or reset its backoff.
    void this.tick()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    // A request still in the air outlives the plugin that started it: Signal K restarts
    // plugins on every config save, so this is routine rather than exotic.
    this.inFlight?.abort()
    this.inFlight = null
  }

  status(): KeySyncStatus {
    return {
      state: this.state,
      lastError: this.lastError,
      devices: this.deviceList.length,
      sealing: this.latched
    }
  }

  /**
   * The screens she may seal to, as the shore last answered.
   *
   * Empty means the shore named nobody in its last answer. It is never a stand-in for "we
   * could not ask" - a failed poll leaves the previous answer in place rather than emptying
   * it, because a boat that quietly stopped sealing because a request timed out would be a
   * boat whose promise depends on the weather.
   *
   * Empty is also not, by itself, permission to report in the clear. Whether it is, is
   * `sealing()`, and the two are separate on purpose: this one is the shore's to change.
   */
  devices(): DevicePublicKey[] {
    return this.deviceList
  }

  /**
   * Whether somebody has ever been authorised to read this boat.
   *
   * True from the first answer that named a screen, and after that it stays true through
   * empty lists, restarts and unusable keys alike. It is what the sealing code asks before
   * it is allowed to treat an empty list as "nobody is watching": once an owner has been
   * promised privacy, an empty list is a reason to say nothing, never a reason to say it in
   * the clear. The shore assembles that list, so letting the shore withdraw the promise by
   * answering `[]` would put the whole guarantee in the carrier's hands.
   *
   * Cleared only by `reset()` - an unpairing aboard.
   */
  sealing(): boolean {
    return this.latched
  }

  /** A new pairing is a new life ashore: the previous link's verdict is not hers, and
   *  neither are the screens the last account had authorised. The promise goes with them,
   *  because unpairing is an instruction that can only have come from aboard. */
  reset(): void {
    this.failures = 0
    this.state = 'idle'
    this.lastError = null
    this.published = false
    this.deviceList = []
    this.latched = false
    this.persisted = false
    // A new pairing may ask at once. What the floor meters is repetition, and nothing that
    // came before this belongs to the account she is about to join.
    this.lastPollAt = null
    // A poll already in the air was asked on the old account's token. Both halves are needed:
    // the abort stops the request, the generation stops an answer that had already arrived.
    this.generation++
    this.inFlight?.abort()
    this.inFlight = null
    void this.deps.latch
      .clear()
      .catch((e) => this.deps.debug(`keysync: could not forget that she was sealing: ${String(e)}`))
  }

  /**
   * Write down that she is sealing, once.
   *
   * Only the first time it becomes true, and again on any later poll if that write did not
   * land: a disk that refused once is a disk that may be full, and a boat that believed a
   * failed write would come back from her next restart reporting in the clear.
   */
  private remember(boatId: string): void {
    if (this.persisted) return
    void this.deps.latch.set(boatId).then(
      () => {
        this.persisted = true
      },
      (e) => this.deps.debug(`keysync: could not write down that she is sealing: ${String(e)}`)
    )
  }

  private schedule(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.tick()
    }, delayMs)
  }

  private async tick(): Promise<void> {
    const remote = this.deps.getRemote()

    // Not paired: no keys are made and nothing is sent. The timer keeps running, so
    // pairing her mid-passage publishes without waiting for a restart.
    if (!remote) {
      if (!this.stopped) this.schedule(this.intervalMs)
      return
    }

    await this.poll(remote)

    // stop() may have landed while the request was in the air; rescheduling here would
    // resurrect a stopped instance on a token that may already be stale.
    if (this.stopped) return

    // The poll never ends: the device list is a live answer, not a one-time fact. Only the
    // gap widens, and only while she is failing.
    this.schedule(
      this.failures === 0
        ? this.intervalMs
        : Math.min(this.intervalMs * 2 ** (this.failures - 1), MAX_BACKOFF_MS)
    )
  }

  private async poll(remote: RemoteLink): Promise<void> {
    this.lastPollAt = Date.now()
    // Generated here rather than at pairing time so that a boat which was paired before this
    // code existed - every vessel already in service - makes hers on the next start instead
    // of having to be paired again for a feature she never asked for.
    await this.deps.keys.ensure()
    const pub = this.deps.keys.publicKeys()
    if (!pub) {
      // ensure() answered and there are still no keys: the disk refused the write. Nothing to
      // publish, and publishing keys the boat could not keep would be worse than not trying -
      // she would be recorded ashore under an identity she cannot sign with.
      this.failures++
      this.state = 'failing'
      this.lastError = 'Could not create the keys for this boat on disk.'
      this.deps.debug('keysync: no keys to publish')
      return
    }

    const controller = new AbortController()
    this.inFlight = controller
    const generation = this.generation
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

    try {
      // Her keys ride along until the shore has confirmed them, and stop being sent once it
      // has: after that this is a read, and there is nothing to say that has not been said.
      const res = await fetch(`${this.deps.relayUrl}/keys`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${remote.boatToken}`
        },
        body: JSON.stringify(
          this.published ? {} : { identity: pub.identity, inbox: pub.inbox }
        ),
        signal: controller.signal
      })

      if (!res.ok) {
        this.failures++
        this.state = 'failing'
        this.lastError =
          res.status === 401
            ? 'Siparu no longer recognises this boat. Pair her again.'
            : `Siparu refused the keys for this boat (${res.status}).`
        this.deps.debug(`keysync: ${this.lastError}`)
        return
      }

      const answer = (await res.json()) as { keys?: unknown; devices?: unknown }

      // She was unpaired while this was in the air. Nothing in it is hers any more: the token
      // it was asked with belongs to an account she has left, and so do the screens it names.
      if (generation !== this.generation) return

      if (answer?.keys === 'mismatch') {
        // Not transient and not retried away: the row ashore was written by another copy of
        // her, or her own key file was lost and rebuilt. Devices recognise her by what is
        // ashore, so the cure is an unlink and a fresh pairing. The poll goes on, because the
        // device list is still worth having: what she cannot do is change the identity.
        this.state = 'mismatch'
        this.lastError =
          'Siparu already holds different keys for this boat. Unlink her and pair again.'
        this.deps.debug(`keysync: ${this.lastError}`)
        this.published = true
      } else if (answer?.keys === 'ok') {
        this.published = true
        this.state = 'published'
        this.lastError = null
      } else if (!this.published) {
        // A 200 that confirmed nothing, from a boat that still needs confirming: an older
        // relay that knows nothing about keys, or a newer one speaking a word this build has
        // not learned. Refused rather than assumed good, because a boat certain she is
        // published while the shore holds nothing would seal to screens that cannot verify her.
        this.failures++
        this.state = 'failing'
        this.lastError = 'Siparu did not confirm the keys for this boat.'
        this.deps.debug('keysync: no verdict in the relay answer')
        return
      }

      // An answer that says nothing about devices is not an answer that says there are none.
      // A relay build that renames the field, or a mismatch reply assembled without it, would
      // otherwise empty a working list - and with the latch set, that empties her onto the
      // wire as silence. Only an answer that actually carries the field replaces the list.
      if (Array.isArray(answer?.devices)) {
        // The latch is decided on the RAW answer, before the shapes are checked. A list of
        // nothing but malformed keys is still an owner who has been promised privacy, and
        // what she is owed then is silence - `readDevices` would have thinned it to nothing
        // and left this boat looking like one nobody has ever authorised.
        //
        // It takes an entry that at least claims to be a screen, though. This promise cannot
        // be withdrawn from ashore, so an array of nulls from a confused build must not be
        // able to set it for good.
        if (answer.devices.some(namesAScreen)) {
          this.latched = true
          this.remember(remote.boatId)
        }
        this.deviceList = readDevices(answer.devices)
      }
      this.failures = 0
    } catch (e) {
      this.failures++
      // A mismatch is the actionable thing and it outlives a bad connection. Letting a
      // timeout overwrite it would put "cannot reach Siparu" on the screen of a boat whose
      // real problem is that the shore holds another vessel's identity for her - and she
      // would go on being unreachable after the network came back.
      if (this.state !== 'mismatch') {
        this.state = 'failing'
        this.lastError = 'Cannot reach Siparu. Is the boat online?'
      }
      // Offline is the normal state of a boat, not an incident.
      this.deps.debug(`keysync unreachable: ${String(e)}`)
    } finally {
      clearTimeout(timeout)
      this.inFlight = null
    }
  }
}

/**
 * Whether an entry in the shore's answer is claiming to be a screen at all.
 *
 * Deliberately weaker than the check below: a device whose key is the wrong length is a
 * screen her owner added and something went wrong with, and she is owed silence rather than
 * cleartext for it. An array of nulls is not a screen by any reading, and since the latch it
 * sets cannot be undone from ashore, that distinction is worth the four lines.
 */
function namesAScreen(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false
  const { kid } = entry as { kid?: unknown }
  return typeof kid === 'string' && kid.length > 0
}

/**
 * The device list off the wire, rebuilt from a whitelist.
 *
 * This arrives over the internet and is fed straight into a key agreement, so it is checked
 * by shape rather than trusted: an id and exactly the 43 characters a raw 32-byte X25519 key
 * spells in base64url. A malformed entry is dropped here and the rest of the list still
 * stands, for the same reason the sealing code names a bad key instead of refusing to send -
 * the list is assembled ashore, and one bad row in it must never take a vessel off the air.
 *
 * Stops at the ceiling the sealing code applies anyway, so an answer of twenty thousand rows
 * costs this boat five entries rather than a resident copy of somebody else's mistake.
 */
function readDevices(raw: unknown): DevicePublicKey[] {
  if (!Array.isArray(raw)) return []
  const out: DevicePublicKey[] = []
  for (const entry of raw) {
    if (out.length >= MAX_DEVICES) break
    if (!entry || typeof entry !== 'object') continue
    const { kid, pub, approved_by, approval } = entry as {
      kid?: unknown
      pub?: unknown
      approved_by?: unknown
      approval?: unknown
    }
    // The kid's charset matters beyond tidiness now: it is interpolated into refusal
    // reasons served by /health, so it is held to the same alphabet the database
    // enforces on the way in, not merely to a length.
    if (typeof kid !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(kid)) continue
    if (typeof pub !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(pub)) continue
    // The approval rides along opaquely - whether it VERIFIES is the sealer's question,
    // asked with keys this module never holds. Carried only as a matched pair in the
    // shapes that could possibly verify (a kid, and the 43 characters a 32-byte MAC
    // spells); anything else is dropped from the entry rather than the entry from the
    // list, because a device with a mangled approval is still a screen her owner added.
    if (
      typeof approved_by === 'string' &&
      /^[A-Za-z0-9_-]{1,64}$/.test(approved_by) &&
      typeof approval === 'string' &&
      /^[A-Za-z0-9_-]{43}$/.test(approval)
    ) {
      out.push({ kid, pub, approved_by, approval })
    } else {
      out.push({ kid, pub })
    }
  }
  return out
}

