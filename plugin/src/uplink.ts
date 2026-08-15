/**
 * The boat, saying she is still here.
 *
 * One minute-by-minute POST over HTTPS carrying her clock and nothing else. It used to
 * carry the whole frame, back when a boat with no authorised screen reported in the clear;
 * it cannot seal (a single POST has no key exchange behind it), so when that boat stopped
 * existing this path lost the only content it was ever allowed to carry.
 *
 * What is left still earns its place. The socket is what carries her position, and this is
 * what keeps "she called in a minute ago" true while the socket will not stay up - which is
 * exactly the connection where the difference between a quiet boat and an unreachable one
 * matters. No queue, no backlog, no catching up after a week in a bay with no signal: the
 * vessel keeps the full history herself and serves it herself, and that half must never
 * depend on the internet.
 *
 * Read-only, still: this talks to the relay, not to Signal K. Nothing here emits a
 * delta or a PUT, and the contract holds - grep the codebase, it is a selling point.
 *
 * What it will NOT do, and this is the load-bearing decision: it will not unpair
 * itself. If the relay rejects the token, the boat stops sending and says so on her
 * own screen, but she keeps the token and keeps asking. A relay that answers 401 by
 * mistake - a bad deploy, a database blip, a migration halfway through - would
 * otherwise silently unpair every vessel in the fleet, and every owner would have to
 * walk down to their boat to fix a bug that was ours.
 */
import type { RemoteLink } from './remotelink'

export interface UplinkStatus {
  /** Epoch ms of the last frame the relay accepted. */
  lastSentTs: number | null
  /** Consecutive failures since then. Zero means she is streaming. */
  failures: number
  /**
   * The relay answered, and said no: this token is not one it knows. Either the owner
   * unlinked her from the portal, or she is carrying a credential from a database that
   * no longer exists. Pairing her again is the only cure, and the screen says so.
   */
  rejected: boolean
  /**
   * The relay knows her and is not carrying her: remote watching is not running on the
   * account she belongs to. Nothing aboard is broken and nothing aboard is the cure, which
   * is why it does not share `rejected` - that one sends her owner to the helm to re-pair a
   * boat that would be turned away by the same gate.
   */
  unentitled: boolean
  /** Why the last attempt failed, in words a skipper can act on. */
  lastError: string | null
}

/**
 * What the boat's own screen is told, out of the two uplinks she has.
 *
 * Whichever one is carrying her. While the socket is up the POST path never sends, so its
 * "last sent" stays null and its failure count stays frozen at whatever it last was - and
 * reporting that would tell an owner her boat has never sent a frame, or cannot reach the
 * relay at all, while it is in fact streaming to her perfectly. The panel is there to answer
 * "is she getting through", and there are two ways for her to be getting through.
 *
 * The socket has to be CONNECTED to speak for her, not merely present: everything else - a
 * dial in progress, a stand-off, a dead line - means the POST path is the one being relied on,
 * and so it is the one whose troubles are worth showing.
 */
export function reportedStatus(
  socket:
    | {
        connected: boolean
        lastFrameTs: number | null
        rejected?: boolean
        unentitled?: boolean
        lastError?: string | null
      }
    | null
    | undefined,
  post: UplinkStatus | null
): UplinkStatus | null {
  if (socket?.connected) {
    return {
      lastSentTs: socket.lastFrameTs,
      failures: 0,
      rejected: false,
      unentitled: false,
      lastError: null
    }
  }

  // A socket refused on the account outranks the POST path's own troubles for the same reason
  // a rejected token does: it is the one line that names a cause, and the cause is not on the
  // boat. The sentence travels from the socket rather than being written again here, so the
  // two halves of the uplink cannot end up telling the owner different stories.
  if (socket?.unentitled) {
    return {
      lastSentTs: socket.lastFrameTs,
      failures: 0,
      rejected: false,
      unentitled: true,
      lastError: socket.lastError ?? 'Remote watching is not active on this account.'
    }
  }
  // A socket told "unknown token" names the cause even while it stands off to redial, before
  // the POST path has had its own turn at the door. Losing it here would blank the one line
  // that says why her screen is dead - and, now that re-pairing keys on it to tell a revoked
  // token from a healthy one, would leave "Pair again" unable to recover from an unlink done
  // from ashore.
  if (socket?.rejected) {
    return {
      lastSentTs: socket.lastFrameTs,
      failures: 0,
      rejected: true,
      unentitled: false,
      lastError: 'Siparu no longer recognises this boat. Pair her again.'
    }
  }
  return post
}

export interface UplinkDeps {
  relayUrl: string
  getRemote: () => RemoteLink | undefined
  debug: (msg: string) => void
  /** Send interval. The product's promise is a minute; tests need it shorter. */
  intervalMs?: number
  /**
   * Whether the live socket is genuinely feeding the shore right now.
   *
   * While it is, this path has nothing to add: every sealed frame the socket delivers is
   * already a boat calling in, so a POST a minute would say the same thing later and be paid
   * for twice.
   *
   * It must be pessimistic, and "connected" is not pessimistic enough. A boat with no
   * authorised screen holds a healthy socket and sends nothing down it, on purpose; the shore
   * records only vessels that say something, so if this answered true for her she would be
   * absent from her owner's page while running perfectly well. What the caller passes is
   * therefore whether reports are actually leaving, not whether a line is up.
   */
  liveHealthy?: () => boolean
}

const DEFAULT_INTERVAL_MS = 60_000

/**
 * A boat on a marginal uplink (Starlink through a squall, a phone hotspot at the
 * edge of a cell) must not stack requests on top of each other, and a boat with no
 * uplink at all must not hammer the relay every minute for a fortnight.
 */
const REQUEST_TIMEOUT_MS = 20_000
const MAX_BACKOFF_MS = 15 * 60_000

export class Uplink {
  private timer: NodeJS.Timeout | null = null
  private inFlight: AbortController | null = null
  private readonly intervalMs: number

  // The reschedule after a send happens AFTER an await, and stop() can land inside that
  // window - Signal K restarts plugins on every config save, so it is routine, not
  // exotic. Without this flag the aborted request's rejection walks back into tick()
  // and schedules the next one, and the stopped instance keeps sending alongside the
  // new one, on a token that may already be stale.
  private stopped = false

  private lastSentTs: number | null = null
  private failures = 0
  private rejected = false
  private unentitled = false
  private lastError: string | null = null

  constructor(private readonly deps: UplinkDeps) {
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
  }

  start(): void {
    if (this.timer) return
    this.stopped = false
    this.schedule(this.intervalMs)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    // A request still in the air outlives the plugin that started it. Abort it so it
    // does not land in a dead closure and report a failure nobody is listening to.
    this.inFlight?.abort()
    this.inFlight = null
  }

  status(): UplinkStatus {
    return {
      lastSentTs: this.lastSentTs,
      failures: this.failures,
      rejected: this.rejected,
      unentitled: this.unentitled,
      lastError: this.lastError
    }
  }

  /** A new pairing starts a new life: the previous link's failures are not hers. */
  reset(): void {
    this.lastSentTs = null
    this.failures = 0
    this.rejected = false
    this.unentitled = false
    this.lastError = null
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

    // Not paired: nothing to send and nobody to send it to. The timer keeps running so
    // that pairing her mid-passage starts the feed without a restart.
    if (!remote) {
      if (!this.stopped) this.schedule(this.intervalMs)
      return
    }

    // The socket has it covered. Keep the timer running rather than stopping this uplink: the
    // socket drops without warning and often, and the fallback has to be already ticking when
    // it does - not started by whoever notices.
    if (this.deps.liveHealthy?.()) {
      if (!this.stopped) this.schedule(this.intervalMs)
      return
    }

    await this.send(remote)

    // stop() may have landed while the request was in the air. Rescheduling now would
    // resurrect a stopped uplink, so check before doing it - this is the guard the
    // whole `stopped` flag exists for.
    if (this.stopped) return

    // A rejected token will still be rejected in sixty seconds. Back off to the ceiling
    // and keep knocking: if the refusal was ours to fix, the boat comes back on her own
    // and the owner never learns there was anything to fix.
    const delay = this.failures === 0 ? this.intervalMs : this.backoffMs()
    this.schedule(delay)
  }

  private backoffMs(): number {
    return Math.min(this.intervalMs * 2 ** (this.failures - 1), MAX_BACKOFF_MS)
  }

  private async send(remote: RemoteLink): Promise<void> {
    const controller = new AbortController()
    this.inFlight = controller
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

    try {
      const res = await fetch(`${this.deps.relayUrl}/telemetry`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${remote.boatToken}`
        },
        // Her CLOCK, and nothing else, ever.
        //
        // This path exists to say "she is still here" when the socket will not stay up, and
        // it cannot seal: a POST is a single request with no key exchange behind it. It used
        // to carry the whole frame for a boat that was not sealing, which is exactly the leak
        // the socket side no longer has - the promise would have held on a good connection
        // and lapsed quietly on a bad one, and a bad connection is the one that matters.
        //
        // What is left is enough to keep "she called in at 14:02" true, and it is nothing a
        // carrier was not already going to know from the request arriving at all.
        body: JSON.stringify({ ts: Date.now() }),
        signal: controller.signal
      })

      if (res.ok) {
        this.lastSentTs = Date.now()
        this.failures = 0
        this.rejected = false
        this.unentitled = false
        this.lastError = null
        return
      }

      this.failures++
      this.rejected = res.status === 401
      // Her token is real and the account behind her is not paying, so there is nobody this
      // heartbeat could reach. Counted as a failure so the backoff takes hold - knocking every
      // minute on a door that opens on a payment is the airtime this refusal exists to stop -
      // but named apart from a rejected token, whose cure is a trip to the boat and would end
      // at this same gate.
      this.unentitled = res.status === 403
      this.lastError = this.rejected
        ? 'Siparu no longer recognises this boat. Pair her again.'
        : this.unentitled
          ? 'Remote watching is not active on this account. She is recording as usual, and starts sending again when it is.'
          : `Relay refused the frame (${res.status}).`
      // A rejection is not noise: it means the owner is watching a screen that will
      // never update, and the only thing that fixes it happens on this boat.
      this.deps.debug(`uplink: ${this.lastError}`)
    } catch (e) {
      this.failures++
      this.lastError = 'Cannot reach Siparu. Is the boat online?'
      // Offline is the normal state of a boat, not an incident. Debug, never error:
      // a week in an anchorage must not fill the Signal K log with red.
      this.deps.debug(`uplink unreachable: ${String(e)}`)
    } finally {
      clearTimeout(timeout)
      this.inFlight = null
    }
  }
}
