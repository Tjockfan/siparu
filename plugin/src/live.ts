/**
 * The boat, reporting ashore as it happens.
 *
 * The HTTP uplink next door sends a frame a minute and is not replaced by this: it is what
 * carries her when a marina's network mangles WebSockets, and it is what leaves a last known
 * position behind when she goes offline. This is the half that makes the shore live - the
 * frame reaching her owner's screen the moment it is taken, rather than up to a minute later.
 *
 * Read-only, still. This talks to the relay, not to Signal K; nothing here emits a delta or a
 * PUT, and nothing the shore sends is acted on. The relay does not send anything.
 *
 * She will not unpair herself, and that is the load-bearing decision - the same one the HTTP
 * uplink makes, for the same reason. If the relay says it does not know her token she says so
 * on her own screen and keeps knocking, because a relay answering "unknown" by mistake - a bad
 * deploy, a migration halfway through - would otherwise silently unpair every vessel in the
 * fleet, and every owner would have to walk down to their boat to fix a bug that was ours.
 */
import type { RemoteLink } from './remotelink'
import type {
  HistoryRequest,
  HistoryResponse,
  PathSeriesResult,
  SnapshotsQuery,
  SnapshotsRequest,
  SnapshotsResponse,
  SnapshotsResult
} from './contract'

/**
 * How often a frame goes up while the socket is open, when she is under way.
 *
 * The relay's Durable Object bills one invocation per frame, and the free-tier ceiling is
 * 100,000 requests a day for the whole account. At two seconds that is 43,200 a day for ONE
 * connected boat - two boats exhausted the plan, which is what this number cost on 18 Jul.
 * Ten seconds is 8,640 a day, and at six knots a boat has moved about thirty metres between
 * frames, still around a boat length and imperceptible for a "where is she now" view. The
 * relay floor is 500ms, so this sits well clear of it. When she is not moving the cadence
 * drops much further still - see STILL_FRAME_EVERY_MS and the adaptive scheduler.
 */
export const FRAME_EVERY_MS = 10_000

/**
 * How often a frame goes up while she is stationary - at anchor or in a berth, where the
 * position simply does not change. A boat spends most of her life here, so this is where the
 * daily cost is actually decided: at sixty seconds a still boat is 1,440 invocations a day
 * rather than 8,640, which is what lets tens of boats share the free tier instead of two.
 */
export const STILL_FRAME_EVERY_MS = 60_000

/**
 * Below this speed she is treated as stationary and the slow cadence applies. In metres per
 * second, because that is the unit the snapshot carries. 0.3 kn is drift and swing at anchor,
 * not passage-making; the first frame that shows real way switches her back to the fast rate.
 */
const UNDERWAY_SOG_MS = 0.3 * 0.514444

/**
 * Starlink sits behind CGNAT, which drops an idle flow in around a minute. The relay answers
 * this without waking the Durable Object at all, so it costs nothing to send and everything
 * to leave out.
 */
export const PING_EVERY_MS = 25_000

/** A boat with no uplink must not knock every five seconds for a fortnight. */
const RECONNECT_BASE_MS = 5_000
const RECONNECT_CEILING_MS = 15 * 60_000

/**
 * What she waits after being told something that redialling cannot fix: an unknown token, or a
 * newer socket of hers taking over. Long, deliberately - see the close handler.
 */
const STAND_OFF_MS = 15 * 60_000

/** Not paired yet. She looks again, so that pairing her mid-passage needs no restart. */
const UNPAIRED_RECHECK_MS = 60_000

/**
 * The relay closes a socket with a reason, and the reason decides what she does next.
 *
 * 1012 is measured, not assumed: connect twice with one token against the live relay and the
 * first socket is closed with exactly this. 1008 is the narrow case - the token was revoked
 * while she was connected. A token that was already unknown when she dialled never reaches a
 * close code at all: the relay refuses the handshake with a 401, which arrives as a refusal
 * rather than a closure, and is handled there.
 */
const CLOSE_UNKNOWN_TOKEN = 1008
const CLOSE_REPLACED = 1012

/** HTTP, not WebSocket: this one comes back instead of an upgrade. */
const REFUSED_UNKNOWN_TOKEN = 401

/**
 * A handshake that never finishes. The TCP connection is up, so nothing errors and nothing
 * closes - a captive portal or a CGNAT black hole simply never answers, and without this the
 * dial hangs forever with no timer left running to rescue it.
 */
const HANDSHAKE_TIMEOUT_MS = 15_000

/**
 * The socket, as this file needs it. The real one is a `ws` WebSocket; a test drives a fake.
 * What is being tested here is a state machine, and a real socket would put a network between
 * the test and it.
 */
export interface LiveSocket {
  send(data: string): void
  /** A clean goodbye. Only valid on a line that is still there to hear it. */
  close(code?: number, reason?: string): void
  /**
   * Destroy it now, with no closing handshake.
   *
   * This is what a dead line gets, and close() is not an alternative to it. A close code has to
   * be one the protocol allows on the wire, and the codes that mean "this broke" (1006 among
   * them) are exactly the ones it does not: `ws` throws on them, and it throws AFTER moving the
   * socket to CLOSING - so the frame is never sent, the close event never fires, the destroy
   * timer is never armed, and the socket and its file descriptor are held until the process
   * ends. Reaching for close() on a socket that has stopped answering is how a boat leaks one
   * of each, every time the line drops, for a season.
   */
  terminate(): void
  onOpen(cb: () => void): void
  onMessage(cb: (data: string) => void): void
  onClose(cb: (code: number) => void): void
  onError(cb: (err: unknown) => void): void
  /** The relay answered the upgrade with an HTTP status instead of accepting it. */
  onRefused(cb: (status: number) => void): void
}

export interface LiveStatus {
  connected: boolean
  /** Epoch ms of the last frame she put on the wire. */
  lastFrameTs: number | null
  /** Consecutive failed connections. Zero while she is up. */
  failures: number
  /** The relay does not know this token. Pairing her again is the only cure. */
  rejected: boolean
  lastError: string | null
}

export interface LiveDeps {
  relayUrl: string
  getRemote: () => RemoteLink | undefined
  /** The live snapshot, exactly as the local dashboard reads it. */
  frame: () => unknown
  /**
   * Answers a shore history request from the boat's own store, the same read the local REST
   * /snapshots serves. Absent leaves the socket answering nothing but the keepalive, exactly
   * as it did before there was a history channel - so an old relay, or a boat wired without
   * it, simply never grows the ear. It never reaches Signal K: it reads, it does not steer.
   */
  onHistoryQuery?: (path: string, query: SnapshotsQuery) => Promise<PathSeriesResult>
  /**
   * Answers a shore snapshots request - whole rows over a window, the logbook read - from the
   * same store the local REST /snapshots serves. The sibling of onHistoryQuery: a read, never a
   * command, and it never reaches Signal K. Absent leaves the socket deaf to snapshots requests,
   * so an old relay or a boat wired without it simply never grows the ear.
   */
  onSnapshotsQuery?: (query: SnapshotsQuery) => Promise<SnapshotsResult>
  debug: (msg: string) => void
  /** Injected in tests. In production this is the `ws` adapter at the bottom of the file. */
  connect?: (url: string, token: string) => LiveSocket
  frameEveryMs?: number
  pingEveryMs?: number
}

export class LiveUplink {
  private sock: LiveSocket | null = null
  private connected = false
  private stopped = true

  /**
   * Which socket is the current one. Every handler carries the generation it was born in and
   * does nothing if it is not the one in hand: a socket that has already been replaced still
   * delivers its close event, and acting on it would schedule a redial on top of the
   * connection she already has - one drop becoming two sockets.
   */
  private gen = 0

  private frameTimer: NodeJS.Timeout | null = null
  private pingTimer: NodeJS.Timeout | null = null
  private redialTimer: NodeJS.Timeout | null = null

  /** A ping went out and nothing came back yet. Two of those in a row is a dead line. */
  private awaitingPong = false

  private failures = 0
  private lastFrameTs: number | null = null
  /** SOG (m/s) of the last frame sent; decides how soon the next one goes. Null until seen. */
  private lastSog: number | null = null
  private rejected = false
  private lastError: string | null = null

  /**
   * A fixed cadence pins the interval and turns the adaptive scheduler off - injected in tests
   * that want a predictable rate. In production it is null, and the cadence follows her speed:
   * FRAME_EVERY_MS under way, STILL_FRAME_EVERY_MS at rest.
   */
  private readonly fixedFrameMs: number | null
  private readonly pingEveryMs: number

  constructor(private readonly deps: LiveDeps) {
    this.fixedFrameMs = deps.frameEveryMs ?? null
    this.pingEveryMs = deps.pingEveryMs ?? PING_EVERY_MS
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.dial()
  }

  stop(): void {
    this.stopped = true
    this.gen++ // whatever is in flight is no longer hers
    this.clearTimers()
    this.connected = false
    const sock = this.sock
    this.sock = null
    try {
      sock?.close(1000, 'plugin stopping')
    } catch {
      // Already gone. Signal K restarts a plugin on every config save, so this is routine.
    }
  }

  /**
   * Whether the shore is genuinely being fed from here. The HTTP uplink stands down while this
   * is true and takes over the moment it is false, so it must never be optimistic: a live
   * uplink that lies about its health takes the fallback down with it and the boat goes silent
   * altogether.
   */
  healthy(): boolean {
    return !this.stopped && this.connected
  }

  status(): LiveStatus {
    return {
      connected: this.connected,
      lastFrameTs: this.lastFrameTs,
      failures: this.failures,
      rejected: this.rejected,
      lastError: this.lastError
    }
  }

  /**
   * A new pairing starts a new life: the previous link's failures are not hers.
   *
   * And it dials again at once. Pairing her again is the cure the screen prescribes for a
   * rejected token - so the cure must not sit out the punishment. The stand-off left by the
   * old link is a quarter of an hour long, and without this the owner would fix the problem,
   * watch the boat stay dark for fifteen minutes, and conclude that it did not work.
   */
  reset(): void {
    this.failures = 0
    this.rejected = false
    this.lastError = null
    this.lastFrameTs = null
    if (this.stopped) return

    const old = this.sock
    this.gen++
    this.clearTimers()
    this.connected = false
    this.sock = null
    if (old) this.kill(old)
    this.dial()
  }

  private dial(): void {
    if (this.stopped) return

    const remote = this.deps.getRemote()
    if (!remote) {
      // Nothing to send and nobody to send it to. She looks again rather than giving up, so
      // that pairing her at sea starts the feed without a restart.
      this.redialTimer = setTimeout(() => this.dial(), UNPAIRED_RECHECK_MS)
      return
    }

    const gen = ++this.gen
    const url = `${this.deps.relayUrl.replace(/^http/, 'ws')}/live/boat`
    const connect = this.deps.connect ?? wsConnect

    let sock: LiveSocket
    try {
      sock = connect(url, remote.boatToken)
    } catch (e) {
      this.failed(gen, `Cannot reach Siparu. Is the boat online?`, e)
      return
    }
    this.sock = sock

    sock.onOpen(() => {
      if (gen !== this.gen) return
      this.connected = true
      this.failures = 0
      this.rejected = false
      this.lastError = null
      this.awaitingPong = false

      // At once, not after an interval: the shore's whole reason for wanting this socket is to
      // know she is there, and making it wait would be theatre.
      this.sendFrame(gen)
      this.scheduleFrame(gen)
      this.pingTimer = setInterval(() => this.keepalive(gen), this.pingEveryMs)
    })

    sock.onMessage((data) => {
      if (gen !== this.gen) return
      if (data === 'pong') {
        this.awaitingPong = false
        return
      }
      // Beyond a pong, the shore may ask the boat to send back her own recorded history: one
      // gauge's series (handleHistory) or whole snapshot rows (handleSnapshots). Neither is a
      // command; each drops in silence anything that is not its own request, and anything that
      // is neither is not acted on at all, because the shore may not steer a boat.
      this.handleHistory(gen, data)
      this.handleSnapshots(gen, data)
    })

    sock.onClose((code) => {
      if (gen !== this.gen) return
      this.closed(gen, code)
    })

    sock.onError((e) => {
      if (gen !== this.gen) return
      // An error is followed by a close on a real socket, but not always, and not on every
      // implementation. Destroying it here makes the two paths one.
      this.deps.debug(`live uplink error: ${String(e)}`)
      this.kill(sock)
      this.closed(gen, 1006)
    })

    // The relay looked at her token and would not even open the socket. This is the ordinary
    // way an unknown token is refused - a boat whose owner unlinked her dials, and is turned
    // away at the door rather than let in and shown out. Telling her "the boat is offline"
    // here, which is what a bare connection error would have said, would send a skipper to
    // check an aerial that is working perfectly.
    sock.onRefused((status) => {
      if (gen !== this.gen) return
      this.kill(sock)
      this.closed(gen, status === REFUSED_UNKNOWN_TOKEN ? CLOSE_UNKNOWN_TOKEN : 1006)
    })
  }

  /** The only thing that reliably ends a socket that may already be broken. */
  private kill(sock: LiveSocket): void {
    try {
      sock.terminate()
    } catch {
      // Already gone, which is the outcome we wanted.
    }
  }

  private sendFrame(gen: number): void {
    if (gen !== this.gen || !this.sock) return
    try {
      const frame = this.deps.frame()
      // Read her speed off the frame we are about to send: it decides how soon the next one
      // goes. LiveResult carries sog at the top level, in m/s. Anything else leaves it null,
      // which the scheduler treats as under way - the safe side, keeping her fresh.
      const sog = (frame as { sog?: unknown }).sog
      this.lastSog = typeof sog === 'number' && Number.isFinite(sog) ? sog : null
      this.sock.send(JSON.stringify(frame))
      this.lastFrameTs = Date.now()
    } catch (e) {
      // The socket died under her. Treat it as the drop it is, rather than throwing inside a
      // timer where nobody is listening.
      this.deps.debug(`live uplink send failed: ${String(e)}`)
      this.kill(this.sock)
      this.closed(gen, 1006)
    }
  }

  /**
   * The next frame is a self-rescheduling timeout, not a fixed interval, so its delay can
   * follow her speed: fast under way, slow at rest. A still boat at a berth is most of the
   * fleet's life and nearly all of the daily cost, so dropping her to a frame a minute is what
   * keeps the Durable Object bill within a free tier that tens of boats share.
   */
  private scheduleFrame(gen: number): void {
    if (gen !== this.gen || this.stopped) return
    this.frameTimer = setTimeout(() => {
      if (gen !== this.gen) return
      this.sendFrame(gen)
      this.scheduleFrame(gen)
    }, this.nextFrameDelayMs())
  }

  private nextFrameDelayMs(): number {
    if (this.fixedFrameMs !== null) return this.fixedFrameMs
    if (this.lastSog !== null && this.lastSog < UNDERWAY_SOG_MS) return STILL_FRAME_EVERY_MS
    return FRAME_EVERY_MS
  }

  /**
   * A history request from the shore, answered from the boat's own store.
   *
   * This is the whole of the inbound surface, and it is deliberately narrow: parse the
   * message, and act only if it is a history request. A command, a PUT, a malformed line -
   * anything else - is dropped in silence, because there is no other thing the shore is
   * allowed to ask and answering would be a reply to make of a surface. The query goes to the
   * store, never to Signal K, and the store read is already clamped (today-only for raw, a
   * hard row cap for rollups), so a request cannot ask the boat for more than she will give.
   */
  private handleHistory(gen: number, data: string): void {
    const handler = this.deps.onHistoryQuery
    if (!handler) return

    let msg: unknown
    try {
      msg = JSON.parse(data)
    } catch {
      return
    }
    if (!isHistoryRequest(msg)) return

    const { id, path, query } = msg
    handler(path, query).then(
      (result) => this.reply(gen, { type: 'history', id, result }),
      (err) => {
        // The caught text stays here, in the debug log - it can hold a data-dir path, and the
        // reply crosses the wire to the shore. What the shore gets is that the query failed,
        // which is all a screen waiting on a chart needs to stop waiting.
        this.deps.debug(`history query failed: ${String(err)}`)
        this.reply(gen, {
          type: 'history',
          id,
          error: { code: 'HISTORY_FAILED', message: 'history query failed' }
        })
      }
    )
  }

  /**
   * A snapshots request from the shore, answered from the boat's own store - the mirror of
   * handleHistory, and just as narrow. Parse, act only if it is a snapshots request, and read
   * the store, never Signal K. The store read is already clamped (today-only for raw, a hard
   * row cap for rollups), so a request cannot ask the boat for more than she will give.
   */
  private handleSnapshots(gen: number, data: string): void {
    const handler = this.deps.onSnapshotsQuery
    if (!handler) return

    let msg: unknown
    try {
      msg = JSON.parse(data)
    } catch {
      return
    }
    if (!isSnapshotsRequest(msg)) return

    const { id, query } = msg
    handler(query).then(
      (result) => this.reply(gen, { type: 'snapshots', id, result }),
      (err) => {
        this.deps.debug(`snapshots query failed: ${String(err)}`)
        this.reply(gen, {
          type: 'snapshots',
          id,
          error: { code: 'SNAPSHOTS_FAILED', message: 'snapshots query failed' }
        })
      }
    )
  }

  /**
   * Send a history or snapshots answer, but only if it still belongs to the socket that asked.
   * A query reads the disk while the line may drop and redial underneath it; the generation
   * guard is what keeps a slow answer from landing on a fresh connection that never asked.
   */
  private reply(gen: number, msg: HistoryResponse | SnapshotsResponse): void {
    if (gen !== this.gen || !this.sock) return
    try {
      this.sock.send(JSON.stringify(msg))
    } catch (e) {
      // The socket died between the query starting and its answer arriving. The close handler
      // has the redial; here there is nothing to do but not throw inside a promise callback.
      this.deps.debug(`history reply send failed: ${String(e)}`)
    }
  }

  private keepalive(gen: number): void {
    if (gen !== this.gen || !this.sock) return

    // A half-open connection looks exactly like a healthy one from this side: the sends
    // succeed and nothing ever comes back. The only way to tell is to ask, and to notice that
    // the last question was never answered.
    if (this.awaitingPong) {
      this.deps.debug('live uplink: no answer to the last keepalive - the line is dead')
      // Destroyed, not closed. There is nobody left to complete a closing handshake with, and
      // asking for one on a dead line is how the socket ends up held open forever.
      this.kill(this.sock)
      this.closed(gen, 1006)
      return
    }

    try {
      this.awaitingPong = true
      this.sock.send('ping')
    } catch (e) {
      this.kill(this.sock)
      this.closed(gen, 1006)
      this.deps.debug(`live uplink keepalive failed: ${String(e)}`)
    }
  }

  private closed(gen: number, code: number): void {
    if (gen !== this.gen) return
    this.gen++ // this socket is finished; nothing it does from here counts
    this.clearTimers()
    this.connected = false
    this.sock = null

    if (this.stopped) return

    if (code === CLOSE_UNKNOWN_TOKEN) {
      // She does not unpair herself. See the file header: a relay that answers "unknown" by
      // mistake would otherwise take the whole fleet off the air, permanently, and the cure
      // would run on every boat rather than on our own server.
      this.rejected = true
      this.lastError = 'Siparu no longer recognises this boat. Pair her again.'
      this.deps.debug(`live uplink: ${this.lastError}`)
      this.redial(STAND_OFF_MS)
      return
    }

    if (code === CLOSE_REPLACED) {
      // A newer socket carrying this same token took over. Redialling would displace THAT
      // one, which would redial and displace this one, and two instances of the plugin would
      // flap against each other forever - waking the Durable Object on every round and
      // billing for it. She stands well back. If the other one is the real boat, she is being
      // reported already; if it dies, this one comes back on its own.
      this.lastError = 'Another copy of this boat is connected to Siparu.'
      this.deps.debug(`live uplink: ${this.lastError}`)
      this.redial(STAND_OFF_MS)
      return
    }

    this.failures++
    this.lastError = 'Cannot reach Siparu. Is the boat online?'
    this.redial(this.backoffMs())
  }

  private failed(gen: number, message: string, e: unknown): void {
    if (gen !== this.gen) return
    this.connected = false
    this.sock = null
    this.failures++
    this.lastError = message
    // Offline is the normal state of a boat, not an incident. Debug, never error: a week in an
    // anchorage must not fill the Signal K log with red.
    this.deps.debug(`live uplink unreachable: ${String(e)}`)
    this.redial(this.backoffMs())
  }

  private backoffMs(): number {
    return Math.min(RECONNECT_BASE_MS * 2 ** Math.max(0, this.failures - 1), RECONNECT_CEILING_MS)
  }

  private redial(delayMs: number): void {
    if (this.stopped) return
    if (this.redialTimer) clearTimeout(this.redialTimer)
    this.redialTimer = setTimeout(() => this.dial(), delayMs)
  }

  private clearTimers(): void {
    if (this.frameTimer) clearTimeout(this.frameTimer)
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.redialTimer) clearTimeout(this.redialTimer)
    this.frameTimer = null
    this.pingTimer = null
    this.redialTimer = null
  }
}

/**
 * Whether a parsed shore message is a history request and nothing else. Strict on purpose:
 * the type tag is the gate that keeps a command from being read as a request, so a message
 * missing it, or carrying a non-string path, or no query object, is not one. The query's own
 * contents (bucket, range) are the store's to validate - it rejects a bad bucket - so they
 * are not re-checked here.
 */
function isHistoryRequest(m: unknown): m is HistoryRequest {
  if (typeof m !== 'object' || m === null) return false
  const o = m as Record<string, unknown>
  return (
    o.type === 'history' &&
    typeof o.id === 'string' &&
    typeof o.path === 'string' &&
    typeof o.query === 'object' &&
    o.query !== null
  )
}

/**
 * A snapshots request, told apart the same way as a history one: the type tag is the gate. It
 * carries no path - the answer is rows, not one series - so only the tag, the id and a query
 * object are checked. The query's own contents (bucket, range) are the store's to validate.
 */
function isSnapshotsRequest(m: unknown): m is SnapshotsRequest {
  if (typeof m !== 'object' || m === null) return false
  const o = m as Record<string, unknown>
  return (
    o.type === 'snapshots' &&
    typeof o.id === 'string' &&
    typeof o.query === 'object' &&
    o.query !== null
  )
}

/**
 * The real socket.
 *
 * `ws` is here rather than the platform's own WebSocket because the compatibility floor is Node
 * 20, where the global one is behind a flag. It carries no install script and no runtime
 * dependency of its own, and its two native helpers are optional peers - which is what lets the
 * Signal K AppStore install this plugin with --ignore-scripts and have it work.
 */
function wsConnect(url: string, token: string): LiveSocket {
  // Required lazily so that a test - and a boat that never pairs - never loads it at all.

  const WS = require('ws') as typeof import('ws')
  const sock = new WS(url, {
    headers: { authorization: `Bearer ${token}` },
    // Opt-in, and without it a handshake that is never answered is never abandoned either.
    handshakeTimeout: HANDSHAKE_TIMEOUT_MS
  })

  return {
    send: (data) => sock.send(data),
    close: (code, reason) => sock.close(code, reason),
    terminate: () => sock.terminate(),
    onOpen: (cb) => sock.on('open', cb),
    onMessage: (cb) => sock.on('message', (d: unknown) => cb(String(d))),
    onClose: (cb) => sock.on('close', (code: number) => cb(code)),
    onError: (cb) => sock.on('error', cb),
    // ws reports a refused upgrade here first, and only then as an error. Taking it here is
    // what lets a 401 be read as "she is not paired any more" rather than "the boat is offline".
    onRefused: (cb) =>
      sock.on('unexpected-response', (_req: unknown, res: { statusCode?: number }) =>
        cb(res.statusCode ?? 0)
      )
  }
}
