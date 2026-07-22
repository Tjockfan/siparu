import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteLink } from '../src/config'
import { PathSeriesResult, PhaseListResult, SnapshotsResult, TrackResult, VoyageListResult } from '../src/contract'
import { FRAME_EVERY_MS, LiveSocket, LiveUplink, PING_EVERY_MS, STILL_FRAME_EVERY_MS } from '../src/live'

/**
 * The live uplink is the one part of the boat that holds a connection open to the shore
 * for months at a time, so what is tested here is what it does when that connection goes
 * wrong - which, at sea, is most of the time.
 *
 * The socket is injected. A real one would put a network between the test and the thing
 * being tested, and the thing being tested is a state machine, not a network.
 */

const REMOTE: RemoteLink = {
  boatId: 'boat-1',
  boatToken: 'tok-secret',
  pairedEmail: 'o***@example.com',
  pairedAt: '2026-07-13T04:00:00.000Z'
}

/**
 * Codes the WebSocket protocol will not put on the wire. `ws` throws a TypeError on these, and
 * it throws after moving the socket to CLOSING - so the close never happens and the socket is
 * held open for the life of the process. The fake is strict about it for exactly that reason:
 * a lenient fake accepted close(1006) happily, and the leak lived behind a green test.
 */
const NOT_SENDABLE = new Set([1005, 1006, 1015])

/** A socket the test drives by hand: nothing happens until the test says it happens. */
class FakeSocket implements LiveSocket {
  sent: string[] = []
  closedWith: number | null = null
  terminated = false
  private handlers: Record<string, (...a: never[]) => void> = {}

  send(data: string): void {
    if (this.dead()) throw new Error('send on a closed socket')
    this.sent.push(data)
  }

  close(code?: number): void {
    if (code !== undefined && NOT_SENDABLE.has(code)) {
      // Precisely what `ws` does, in the order it does it: the socket is left CLOSING and the
      // caller gets an exception, so a caller that swallows it has leaked the socket.
      throw new TypeError('First argument must be a valid error code number')
    }
    this.closedWith = code ?? 1000
  }

  terminate(): void {
    this.terminated = true
  }

  /** Gone by either road - which is what the uplink has to achieve, however it gets there. */
  dead(): boolean {
    return this.closedWith !== null || this.terminated
  }

  onOpen(cb: () => void): void {
    this.handlers.open = cb as never
  }
  onMessage(cb: (data: string) => void): void {
    this.handlers.message = cb as never
  }
  onClose(cb: (code: number) => void): void {
    this.handlers.close = cb as never
  }
  onError(cb: (err: unknown) => void): void {
    this.handlers.error = cb as never
  }
  onRefused(cb: (status: number) => void): void {
    this.handlers.refused = cb as never
  }
  refused(status: number): void {
    ;(this.handlers.refused as ((s: number) => void) | undefined)?.(status)
  }

  // What the relay does to her, from the test's side of the wire.
  open(): void {
    ;(this.handlers.open as (() => void) | undefined)?.()
  }
  say(msg: string): void {
    ;(this.handlers.message as ((d: string) => void) | undefined)?.(msg)
  }
  closedByRelay(code: number): void {
    this.closedWith = code
    ;(this.handlers.close as ((c: number) => void) | undefined)?.(code)
  }
  broke(): void {
    ;(this.handlers.error as ((e: unknown) => void) | undefined)?.(new Error('ECONNRESET'))
  }

  /** The frames she actually put on the wire, keepalives excluded. */
  frames(): unknown[] {
    return this.sent.filter((s) => s !== 'ping').map((s) => JSON.parse(s))
  }
  pings(): number {
    return this.sent.filter((s) => s === 'ping').length
  }

  /** Only the history answers she sent - a request's reply, tagged by type. */
  historyReplies(): Array<Record<string, unknown>> {
    return this.repliesOfType('history')
  }
  /** Only the snapshots answers she sent - the sibling of historyReplies. */
  snapshotsReplies(): Array<Record<string, unknown>> {
    return this.repliesOfType('snapshots')
  }
  /** Only the voyages answers she sent - the third sibling. */
  voyagesReplies(): Array<Record<string, unknown>> {
    return this.repliesOfType('voyages')
  }
  /** Only the track answers she sent - the fourth sibling. */
  trackReplies(): Array<Record<string, unknown>> {
    return this.repliesOfType('track')
  }
  /** Only the phases answers she sent - the fifth sibling. */
  phasesReplies(): Array<Record<string, unknown>> {
    return this.repliesOfType('phases')
  }
  private repliesOfType(type: string): Array<Record<string, unknown>> {
    return this.sent
      .filter((s) => s !== 'ping')
      .map((s) => JSON.parse(s) as Record<string, unknown>)
      .filter((m) => m && m.type === type)
  }
}

/**
 * Drain the microtask queue. The history handler answers off a promise, and the fake
 * timers do not touch microtasks - so a resolved query's reply is one flush away, not one
 * tick. A handful of turns covers the promise chain with room to spare.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

/** Every socket the uplink asked for, in order. */
function uplink(over: Partial<ConstructorParameters<typeof LiveUplink>[0]> = {}) {
  const sockets: FakeSocket[] = []
  const tokens: string[] = []
  const live = new LiveUplink({
    relayUrl: 'https://relay.example',
    getRemote: () => REMOTE,
    frame: () => ({ ts: 1_752_400_000_000, lat: 43.5, lon: 7.0, sog: 3.2 }),
    debug: () => {},
    connect: (_url, token) => {
      tokens.push(token)
      const s = new FakeSocket()
      sockets.push(s)
      return s
    },
    ...over
  })
  return { live, sockets, tokens, last: () => sockets[sockets.length - 1] }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('reporting sealed', () => {
  it('sends the sealed envelope instead of the frame', () => {
    // The wiring, pinned where it lives. The sealer is proved next door; what is proved here
    // is that its answer is the thing that reaches the wire.
    const { live, last } = uplink({
      seal: () => ({ mode: 'sealed', frame: { v: 1, boat: 'boat-1', body: 'ciphertext' } })
    })
    live.start()
    last().open()

    const sent = last().frames()[0] as Record<string, unknown>
    expect(sent.type).toBe('sealed')
    expect(sent.frame).toEqual({ v: 1, boat: 'boat-1', body: 'ciphertext' })
    // And the cleartext she was about to send is nowhere on the wire.
    expect(JSON.stringify(sent)).not.toContain('43.5')
  })

  it('sends NOTHING when the sealer is blocked', () => {
    // Screens are authorised and none can be sealed to. A cleartext frame here would be the
    // quiet betrayal the whole switch exists to prevent, so the socket carries nothing and
    // her owner sees a boat that stopped reporting.
    const { live, last } = uplink({ seal: () => ({ mode: 'blocked' }) })
    live.start()
    last().open()

    expect(last().frames()).toHaveLength(0)
  })

  it('sends the plain frame when the sealer says nobody is authorised', () => {
    const { live, last } = uplink({ seal: () => ({ mode: 'clear' }) })
    live.start()
    last().open()

    expect(last().frames()[0]).toMatchObject({ lat: 43.5 })
  })

  it('keeps her cadence off the cleartext speed while sending sealed', () => {
    // Her speed decides how soon the next frame goes, and it is read off the frame BEFORE
    // sealing. If that reading moved after the switch, a boat under way would drop to the
    // resting cadence the day she started sealing, and nobody would connect the two.
    const { live, last } = uplink({
      frame: () => ({ ts: 1, sog: 3.2 }),
      seal: () => ({ mode: 'sealed', frame: { body: 'ciphertext' } })
    })
    live.start()
    last().open()
    expect(last().frames()).toHaveLength(1)

    vi.advanceTimersByTime(FRAME_EVERY_MS)
    expect(last().frames()).toHaveLength(2)
  })
})

describe('what she answers while she is sealing', () => {
  const ask = (type: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type, id: `w-1.${type}-req`, ...extra })

  it('refuses a history question rather than answering it in the clear', () => {
    // Sealing the live frames and answering the past in the clear would leave the promise
    // holding for the present and broken for the bigger half: one snapshots page carries a
    // day of positions where a frame carries one.
    const asked: string[] = []
    const { live, last } = uplink({
      sealed: () => true,
      onHistoryQuery: async (p) => {
        asked.push(p)
        return { path: p, points: [] } as never
      }
    })
    live.start()
    last().open()
    last().say(ask('history', { path: 'navigation.speedOverGround', query: { bucket: 1 } }))

    // The store was never read, and the shore was told why rather than left waiting.
    expect(asked).toHaveLength(0)
    const reply = last().historyReplies().at(-1) as Record<string, unknown>
    expect(reply.type).toBe('history')
    expect(reply.id).toBe('w-1.history-req')
    expect(reply.error).toMatchObject({ code: 'SEALED' })
  })

  it('refuses every kind of question, not only the ones with a query', () => {
    const { live, last } = uplink({ sealed: () => true })
    live.start()
    last().open()

    for (const type of ['snapshots', 'voyages', 'track', 'phases']) {
      last().say(ask(type))
      const reply = last().repliesOfType(type).at(-1) as { error?: { code?: string } } | undefined
      expect(reply?.error?.code, type).toBe('SEALED')
    }
  })

  it('answers normally when she is not sealing', async () => {
    const { live, last } = uplink({
      sealed: () => false,
      onVoyagesQuery: async () => ({ voyages: [] }) as never
    })
    live.start()
    last().open()
    last().say(ask('voyages', { limit: 5 }))
    await flush()

    const reply = last().repliesOfType('voyages').at(-1) as { error?: unknown } | undefined
    expect(reply?.error).toBeUndefined()
  })

  it('still says nothing to a message that is not a question at all', () => {
    // The shore may not steer a boat, and a refusal is still a reply. Anything that is not one
    // of the five reads gets no answer, sealing or not.
    const { live, last } = uplink({ sealed: () => true })
    live.start()
    last().open()
    const before = last().historyReplies().length

    last().say(JSON.stringify({ type: 'put', path: 'steering.rudderAngle', value: 0.3 }))
    last().say('not json at all')

    expect(last().historyReplies()).toHaveLength(before)
  })
})

describe('holding the socket open', () => {
  it('sends a frame on the cadence, not on every tick of the boat', () => {
    const { live, last } = uplink()
    live.start()
    last().open()

    // The first frame goes at once: the shore's reason for wanting the socket is to know
    // she is there, and making it wait two seconds for that would be theatre.
    expect(last().frames()).toHaveLength(1)

    vi.advanceTimersByTime(FRAME_EVERY_MS)
    expect(last().frames()).toHaveLength(2)

    vi.advanceTimersByTime(FRAME_EVERY_MS * 3)
    expect(last().frames()).toHaveLength(5)

    live.stop()
  })

  it('slows to the still cadence when she is not moving, and speeds back up when she is', () => {
    // The Durable Object bills one invocation per frame against a shared daily ceiling, so a
    // boat sat at anchor must not spend the fast rate on a position that is not changing.
    let sog = 0 // at rest
    // Ping pushed past the window: this test is about frame cadence, and the keepalive
    // watchdog (two unanswered pings = a dead line) is a separate mechanism tested elsewhere.
    const { live, last } = uplink({
      pingEveryMs: 10 * 60_000,
      frame: () => ({ ts: 1_752_400_000_000, lat: 43.5, lon: 7.0, sog })
    })
    live.start()
    last().open()
    expect(last().frames()).toHaveLength(1) // the immediate frame, which reads sog=0

    // A fast interval must NOT produce a frame while she is still.
    vi.advanceTimersByTime(FRAME_EVERY_MS)
    expect(last().frames()).toHaveLength(1)

    // The still interval does.
    vi.advanceTimersByTime(STILL_FRAME_EVERY_MS - FRAME_EVERY_MS)
    expect(last().frames()).toHaveLength(2)

    // She gets under way: the frame that reports it switches her back to the fast cadence.
    sog = 3.0
    vi.advanceTimersByTime(STILL_FRAME_EVERY_MS)
    expect(last().frames()).toHaveLength(3) // this frame carries sog=3.0
    vi.advanceTimersByTime(FRAME_EVERY_MS)
    expect(last().frames()).toHaveLength(4) // now on the fast rate again

    live.stop()
  })

  it('treats an unknown speed as under way, keeping her fresh', () => {
    // A boat whose GPS is silent still deserves the live rate: null must not read as "at rest"
    // and drop her to a frame a minute.
    const { live, last } = uplink({ frame: () => ({ ts: 1_752_400_000_000, lat: 43.5, lon: 7.0 }) })
    live.start()
    last().open()
    vi.advanceTimersByTime(FRAME_EVERY_MS)
    expect(last().frames()).toHaveLength(2)
    live.stop()
  })

  it('honours a fixed cadence when one is injected, ignoring speed', () => {
    // Tests that want a predictable rate pin frameEveryMs; the adaptive path stands down.
    const { live, last } = uplink({
      frameEveryMs: 2_000,
      frame: () => ({ ts: 1_752_400_000_000, lat: 43.5, lon: 7.0, sog: 0 })
    })
    live.start()
    last().open()
    vi.advanceTimersByTime(2_000)
    expect(last().frames()).toHaveLength(2) // fired at the pinned 2s despite sog=0
    live.stop()
  })

  it('keeps the flow alive under CGNAT, which drops an idle one in about a minute', () => {
    const { live, last } = uplink()
    live.start()
    last().open()

    vi.advanceTimersByTime(PING_EVERY_MS)
    expect(last().pings()).toBe(1)
    last().say('pong')

    vi.advanceTimersByTime(PING_EVERY_MS)
    expect(last().pings()).toBe(2)

    live.stop()
  })

  it('gives up on a socket that stopped answering, rather than talking to a dead line', () => {
    const { live, sockets, last } = uplink()
    live.start()
    last().open()

    // A half-open TCP connection looks exactly like a healthy one from here: sends succeed,
    // nothing comes back. The only way to tell is to ask, and to notice that it never answered.
    vi.advanceTimersByTime(PING_EVERY_MS) // ping goes out
    expect(last().pings()).toBe(1)

    vi.advanceTimersByTime(PING_EVERY_MS) // still no pong: she is talking to nobody
    expect(sockets[0].dead()).toBe(true)
    expect(live.status().connected).toBe(false)

    live.stop()
  })

  it('does not dial at all until she is paired', () => {
    const { live, sockets } = uplink({ getRemote: () => undefined })
    live.start()
    expect(sockets).toHaveLength(0)
    expect(live.status().connected).toBe(false)
    live.stop()
  })
})

describe('what she does when the shore closes on her', () => {
  it('redials after a broken link, backing off rather than hammering', () => {
    const { live, sockets, last } = uplink()
    live.start()
    last().open()

    last().closedByRelay(1006) // the line broke: nothing was said
    expect(sockets).toHaveLength(1)

    vi.advanceTimersByTime(5_000)
    expect(sockets).toHaveLength(2) // she is back

    // And a second failure waits longer than the first: an offline boat must not spend a
    // fortnight knocking on a relay every five seconds.
    sockets[1].closedByRelay(1006)
    vi.advanceTimersByTime(5_000)
    expect(sockets).toHaveLength(2)
    vi.advanceTimersByTime(5_000)
    expect(sockets).toHaveLength(3)

    live.stop()
  })

  it('does NOT redial when a newer socket of hers took over', () => {
    const { live, sockets, last } = uplink()
    live.start()
    last().open()

    // 1012: the relay replaced this socket with a newer one carrying the same token. If she
    // redials, her redial displaces THAT one, which redials, which displaces hers - two
    // instances of the plugin flapping against each other forever, waking the Durable Object
    // on every round and billing for it. She stands well back instead.
    last().closedByRelay(1012)

    vi.advanceTimersByTime(60_000)
    expect(sockets).toHaveLength(1)

    live.stop()
  })

  it('keeps her token when the relay says it does not know her, and keeps knocking', () => {
    const { live, sockets, last } = uplink()
    live.start()
    last().open()

    // 1008: the relay does not recognise the token. It might be true - the owner unlinked
    // her - or it might be a bad deploy of ours answering for a database that is halfway
    // through a migration. Unpairing herself on being told so would mean a bug of ours
    // silently unpairs the entire fleet, and every owner walks down to their boat to fix it.
    //
    // So she says it on her own screen, and she keeps the token, and she keeps asking.
    last().closedByRelay(1008)
    expect(live.status().rejected).toBe(true)
    expect(live.status().lastError).toMatch(/pair her again/i)

    vi.advanceTimersByTime(60_000)
    expect(sockets).toHaveLength(1) // not hammering

    vi.advanceTimersByTime(15 * 60_000)
    expect(sockets.length).toBeGreaterThan(1) // but not given up either

    live.stop()
  })

  it('ignores the death of a socket she has already replaced', () => {
    const { live, sockets, last } = uplink()
    live.start()
    last().open()

    last().closedByRelay(1006)
    vi.advanceTimersByTime(5_000)
    expect(sockets).toHaveLength(2)

    // The old socket's close event arriving late must not schedule a second redial on top
    // of the connection she already has: that is how one drop turns into two sockets.
    sockets[0].closedByRelay(1006)
    vi.advanceTimersByTime(60_000)
    expect(sockets).toHaveLength(2)

    live.stop()
  })
})

describe('what the HTTP uplink is told', () => {
  it('is healthy only while a socket is open and answering', () => {
    const { live, last } = uplink()
    expect(live.healthy()).toBe(false) // not started

    live.start()
    expect(live.healthy()).toBe(false) // dialling, not connected

    last().open()
    expect(live.healthy()).toBe(true)

    // The POST path is what carries her while this is false, so a socket that dies must
    // report itself dead at once - a live uplink that lies about its health takes the
    // fallback down with it and the boat goes silent altogether.
    last().closedByRelay(1006)
    expect(live.healthy()).toBe(false)

    live.stop()
  })

  it('is not healthy once stopped, even though it was a moment ago', () => {
    const { live, last } = uplink()
    live.start()
    last().open()
    expect(live.healthy()).toBe(true)

    live.stop()
    expect(live.healthy()).toBe(false)
  })
})

describe('stopping', () => {
  it('closes the socket and stops the timers', () => {
    const { live, sockets, last } = uplink()
    live.start()
    last().open()

    live.stop()
    expect(sockets[0].dead()).toBe(true)

    // Signal K restarts a plugin on every config save, so a stopped uplink that keeps its
    // timers is not exotic: it is a second uplink, sending on a token that may be stale.
    vi.advanceTimersByTime(10 * 60_000)
    expect(sockets).toHaveLength(1)
  })
})

describe('the line that is already dead', () => {
  it('destroys the socket instead of asking it politely to close', () => {
    const { live, sockets, last } = uplink()
    live.start()
    last().open()

    // Two keepalives with no answer between them: the line is gone.
    vi.advanceTimersByTime(PING_EVERY_MS)
    vi.advanceTimersByTime(PING_EVERY_MS)

    // close(1006) is what this used to do, and `ws` throws on it - after having already moved
    // the socket to CLOSING. The exception was swallowed, so the state machine carried on and
    // the test stayed green while the socket, and its file descriptor, were held open forever.
    // On a boat that drops a line every few hours, that is a leak per drop, all season.
    expect(sockets[0].terminated).toBe(true)
    expect(live.healthy()).toBe(false)

    live.stop()
  })
})

describe('a token the relay will not even let in', () => {
  it('reads a refused handshake as an unknown token, not as a boat that is offline', () => {
    const { live, sockets, last } = uplink()
    live.start()

    // This is how an unlinked boat is actually turned away: the relay refuses the upgrade with
    // a 401 rather than accepting the socket and closing it with 1008. Read as a bare
    // connection error - which is what it looks like - it would say "Is the boat online?", and
    // send a skipper up the mast to check an aerial that is working perfectly.
    last().refused(401)

    expect(live.status().rejected).toBe(true)
    expect(live.status().lastError).toMatch(/pair her again/i)
    expect(sockets[0].dead()).toBe(true)

    // And she stands off rather than hammering a door that is not going to open.
    vi.advanceTimersByTime(60_000)
    expect(sockets).toHaveLength(1)

    live.stop()
  })

  it('treats any other refusal as the relay having a bad day, and comes back soon', () => {
    const { live, sockets, last } = uplink()
    live.start()
    last().refused(502)

    expect(live.status().rejected).toBe(false)
    vi.advanceTimersByTime(5_000)
    expect(sockets).toHaveLength(2) // a bad gateway is not a verdict on her token

    live.stop()
  })
})

describe('being paired again', () => {
  it('dials at once rather than sitting out the old link\'s stand-off', () => {
    const { live, sockets, last } = uplink()
    live.start()
    last().refused(401)
    expect(live.status().rejected).toBe(true)

    // The owner pairs her again - which is the cure the screen just prescribed. If the cure has
    // to wait out the fifteen-minute punishment left by the old link, the owner fixes the
    // problem, watches the boat stay dark, and concludes that it did not work.
    live.reset()

    expect(sockets).toHaveLength(2)
    expect(live.status().rejected).toBe(false)
    sockets[1].open()
    expect(live.healthy()).toBe(true)

    live.stop()
  })
})

describe('the one thing the shore may say: asking for her history', () => {
  const SERIES: PathSeriesResult = {
    path: 'propulsion.port.revolutions',
    points: [{ ts: 1_752_400_000_000, min: 700, max: 900, avg: 800, last: 850 }],
    clamped: false
  }

  it('answers from her own store, tagged with the id that asked', async () => {
    const onHistoryQuery = vi.fn().mockResolvedValue(SERIES)
    const { live, last } = uplink({ onHistoryQuery })
    live.start()
    last().open()

    last().say(
      JSON.stringify({
        type: 'history',
        id: 'q1',
        path: 'propulsion.port.revolutions',
        query: { bucket: 60 }
      })
    )
    await flush()

    // She read her own recorded history and sent it back. The query reached the store
    // untouched; nothing about it went to Signal K.
    expect(onHistoryQuery).toHaveBeenCalledWith('propulsion.port.revolutions', { bucket: 60 })
    expect(last().historyReplies()).toEqual([{ type: 'history', id: 'q1', result: SERIES }])

    live.stop()
  })

  it('sends back a reason when the store cannot build the series, rather than silence', async () => {
    const onHistoryQuery = vi.fn().mockRejectedValue(new Error('bucket must be one of 1, 60, 360, 1440'))
    const { live, last } = uplink({ onHistoryQuery })
    live.start()
    last().open()

    last().say(JSON.stringify({ type: 'history', id: 'q2', path: 'x', query: { bucket: 7 } }))
    await flush()

    // The failure is answered, carrying the id so the screen that asked can stop waiting.
    // The message is fixed, not the caught error's text: that text can hold a data-dir path,
    // and this reply crosses the wire to the shore.
    expect(last().historyReplies()).toEqual([
      { type: 'history', id: 'q2', error: { code: 'HISTORY_FAILED', message: 'history query failed' } }
    ])

    live.stop()
  })

  it('acts on nothing else the shore sends - a command is not a request', async () => {
    const onHistoryQuery = vi.fn().mockResolvedValue(SERIES)
    const { live, last } = uplink({ onHistoryQuery })
    live.start()
    last().open()

    // Everything a hostile or broken shore might try. None of it is a history request, so
    // none of it is acted on - the boat takes no command, and the read-only promise is that
    // there is nothing here that could carry one.
    last().say(JSON.stringify({ type: 'put', path: 'steering.rudderAngle', value: 0.5 }))
    last().say(JSON.stringify({ type: 'command', name: 'reboot' }))
    last().say(JSON.stringify({ type: 'history_result', id: 'x', result: SERIES }))
    last().say('steer to port')

    // The dangerous one, and the reason the type tag is the gate: a command wearing a
    // request's clothes - id, path and a valid query, everything but type: 'history'. If the
    // tag ever stopped being what decides, THIS is what would run. It pins the gate to the
    // one field that separates a read from a command.
    last().say(
      JSON.stringify({ type: 'put', id: 'evil', path: 'propulsion.port.revolutions', query: { bucket: 60 } })
    )
    await flush()

    expect(onHistoryQuery).not.toHaveBeenCalled()
    expect(last().historyReplies()).toHaveLength(0)

    live.stop()
  })

  it('does nothing with a history request when the feature is not wired', async () => {
    const { live, last } = uplink() // no onHistoryQuery
    live.start()
    last().open()

    last().say(JSON.stringify({ type: 'history', id: 'q1', path: 'x', query: { bucket: 60 } }))
    await flush()

    expect(last().historyReplies()).toHaveLength(0)

    live.stop()
  })

  it('still hears a pong after learning to hear history', () => {
    const onHistoryQuery = vi.fn().mockResolvedValue(SERIES)
    const { live, last } = uplink({ onHistoryQuery })
    live.start()
    last().open()

    // The keepalive shares the message handler with history now. A pong must still clear the
    // outstanding-ping flag, or the second keepalive would declare a live line dead.
    vi.advanceTimersByTime(PING_EVERY_MS)
    expect(last().pings()).toBe(1)
    last().say('pong')

    vi.advanceTimersByTime(PING_EVERY_MS)
    expect(last().pings()).toBe(2)
    expect(last().dead()).toBe(false)

    live.stop()
  })

  it('does not answer a query on a socket she has already replaced', async () => {
    let resolveQuery: (r: PathSeriesResult) => void = () => {}
    const onHistoryQuery = vi.fn(
      () => new Promise<PathSeriesResult>((res) => (resolveQuery = res))
    )
    const { live, sockets, last } = uplink({ onHistoryQuery })
    live.start()
    last().open()

    last().say(JSON.stringify({ type: 'history', id: 'q1', path: 'x', query: { bucket: 60 } }))

    // The line breaks and she redials while the query is still reading the disk.
    sockets[0].closedByRelay(1006)
    vi.advanceTimersByTime(5_000)
    expect(sockets).toHaveLength(2)

    // The slow query finishes now. Its answer belongs to a socket that no longer exists, and
    // must not be sent down the new one - a stale reply landing on a fresh connection would
    // answer a request the new socket never made.
    resolveQuery({ path: 'x', points: [], clamped: false })
    await flush()

    expect(sockets[0].historyReplies()).toHaveLength(0)
    expect(sockets[1].historyReplies()).toHaveLength(0)

    live.stop()
  })
})

describe('the sibling the shore may say: asking for her snapshots', () => {
  const ROWS: SnapshotsResult = {
    rows: [
      {
        ts: 1_752_400_000_000,
        lat: 43.5,
        lon: 7.0,
        sog: 3.2,
        cog: null,
        heading_mag: null,
        heading_true: null,
        rate_of_turn: null,
        magnetic_variation: null,
        magnetic_deviation: null,
        nav_state: null,
        wind_speed_apparent: null,
        wind_angle_apparent: null,
        wind_speed_true: null,
        wind_gust: null,
        wind_direction_true: null,
        air_temp_k: null,
        air_pressure_pa: null,
        depth: null,
        water_temp_k: null,
        gps_satellites: null,
        ais_class: null
      }
    ],
    clamped: false
  }

  it('answers rows from her own store, tagged with the id that asked, and no path leaks in', async () => {
    const onSnapshotsQuery = vi.fn().mockResolvedValue(ROWS)
    const { live, last } = uplink({ onSnapshotsQuery })
    live.start()
    last().open()

    last().say(JSON.stringify({ type: 'snapshots', id: 's1', query: { bucket: 60 } }))
    await flush()

    // The query reached the store untouched - the same read the local /snapshots serves - and
    // carried no path, because the answer is rows, not one series.
    expect(onSnapshotsQuery).toHaveBeenCalledWith({ bucket: 60 })
    expect(last().snapshotsReplies()).toEqual([{ type: 'snapshots', id: 's1', result: ROWS }])
    // A snapshots request must not be mistaken for a history one, nor answered twice.
    expect(last().historyReplies()).toHaveLength(0)

    live.stop()
  })

  it('sends back a reason when the store cannot build the rows, rather than silence', async () => {
    const onSnapshotsQuery = vi.fn().mockRejectedValue(new Error('bucket must be one of 1, 60, 360, 1440'))
    const { live, last } = uplink({ onSnapshotsQuery })
    live.start()
    last().open()

    last().say(JSON.stringify({ type: 'snapshots', id: 's2', query: { bucket: 7 } }))
    await flush()

    // The failure carries a fixed message, not the caught error's text: that text can hold a
    // data-dir path, and this reply crosses the wire to the shore.
    expect(last().snapshotsReplies()).toEqual([
      { type: 'snapshots', id: 's2', error: { code: 'SNAPSHOTS_FAILED', message: 'snapshots query failed' } }
    ])

    live.stop()
  })

  it('acts on nothing else - a command wearing a snapshots query is still not one', async () => {
    const onSnapshotsQuery = vi.fn().mockResolvedValue(ROWS)
    const onHistoryQuery = vi.fn().mockResolvedValue({ path: 'x', points: [], clamped: false })
    const { live, last } = uplink({ onSnapshotsQuery, onHistoryQuery })
    live.start()
    last().open()

    // A command wearing the request's clothes - an id and a valid query, everything but the
    // type tag. The tag is the gate; if it ever stopped deciding, this is what would run.
    last().say(JSON.stringify({ type: 'put', id: 'evil', path: 'x', query: { bucket: 60 } }))
    await flush()

    expect(onSnapshotsQuery).not.toHaveBeenCalled()
    expect(onHistoryQuery).not.toHaveBeenCalled()
    expect(last().snapshotsReplies()).toHaveLength(0)

    live.stop()
  })

  it('does nothing with a snapshots request when the feature is not wired', async () => {
    const { live, last } = uplink() // no onSnapshotsQuery
    live.start()
    last().open()

    last().say(JSON.stringify({ type: 'snapshots', id: 's1', query: { bucket: 60 } }))
    await flush()

    expect(last().snapshotsReplies()).toHaveLength(0)

    live.stop()
  })
})

describe('the third sibling the shore may say: asking for her voyages', () => {
  const VOYAGES: VoyageListResult = {
    voyages: [
      {
        id: 7,
        start_ts: 1_752_400_000_000,
        end_ts: 1_752_410_000_000,
        start_lat: 43.5,
        start_lon: 7.0,
        end_lat: 43.7,
        end_lon: 7.3,
        distance_nm: 12.4,
        hours_underway: 2.8,
        avg_sog_kn: 4.4,
        max_sog_kn: 6.1,
        fuel_used_l: null,
        start_port: null,
        end_port: null,
        status: 'closed'
      }
    ]
  }

  it('answers her voyages, tagged with the id that asked, and the count reaches the store', async () => {
    const onVoyagesQuery = vi.fn().mockResolvedValue(VOYAGES)
    const { live, last } = uplink({ onVoyagesQuery })
    live.start()
    last().open()

    last().say(JSON.stringify({ type: 'voyages', id: 'v1', limit: 50 }))
    await flush()

    // The count reached the store untouched, and the answer came back tagged with its id.
    expect(onVoyagesQuery).toHaveBeenCalledWith(50)
    expect(last().voyagesReplies()).toEqual([{ type: 'voyages', id: 'v1', result: VOYAGES }])
    // A voyages request is neither of its siblings, nor answered twice.
    expect(last().snapshotsReplies()).toHaveLength(0)
    expect(last().historyReplies()).toHaveLength(0)

    live.stop()
  })

  it('sends back a reason when the store cannot list them, rather than silence', async () => {
    const onVoyagesQuery = vi.fn().mockRejectedValue(new Error('/var/db/voyages.ndjson unreadable'))
    const { live, last } = uplink({ onVoyagesQuery })
    live.start()
    last().open()

    last().say(JSON.stringify({ type: 'voyages', id: 'v2', limit: 50 }))
    await flush()

    // A fixed message, not the caught error's text: that text can hold a data-dir path, and this
    // reply crosses the wire to the shore.
    expect(last().voyagesReplies()).toEqual([
      { type: 'voyages', id: 'v2', error: { code: 'VOYAGES_FAILED', message: 'voyages query failed' } }
    ])

    live.stop()
  })

  it('acts on nothing else - a command wearing a voyages count is still not one', async () => {
    const onVoyagesQuery = vi.fn().mockResolvedValue(VOYAGES)
    const { live, last } = uplink({ onVoyagesQuery })
    live.start()
    last().open()

    // A command wearing the request's clothes: an id and a numeric limit, everything but the
    // type tag. The tag is the gate; if it ever stopped deciding, this is what would run.
    last().say(JSON.stringify({ type: 'put', id: 'evil', limit: 50 }))
    // And a voyages-tagged message whose count is not a number is not one either.
    last().say(JSON.stringify({ type: 'voyages', id: 'v3', limit: 'all' }))
    await flush()

    expect(onVoyagesQuery).not.toHaveBeenCalled()
    expect(last().voyagesReplies()).toHaveLength(0)

    live.stop()
  })

  it('does nothing with a voyages request when the feature is not wired', async () => {
    const { live, last } = uplink() // no onVoyagesQuery
    live.start()
    last().open()

    last().say(JSON.stringify({ type: 'voyages', id: 'v1', limit: 50 }))
    await flush()

    expect(last().voyagesReplies()).toHaveLength(0)

    live.stop()
  })
})

describe('the fourth sibling the shore may say: asking for one voyage track', () => {
  const TRACK: TrackResult = {
    track: [
      { ts: 1_752_400_000_000, lat: 43.5, lon: 7.0, sog: 3.2 },
      { ts: 1_752_400_060_000, lat: 43.52, lon: 7.03, sog: 3.4 }
    ],
    decimated: false
  }

  it('answers one voyage path, tagged with the id that asked, and the voyage id reaches the store', async () => {
    const onTrackQuery = vi.fn().mockResolvedValue(TRACK)
    const { live, last } = uplink({ onTrackQuery })
    live.start()
    last().open()

    last().say(JSON.stringify({ type: 'track', id: 't1', voyageId: 7 }))
    await flush()

    // The voyage id reached the store untouched, and the path came back tagged with its id.
    expect(onTrackQuery).toHaveBeenCalledWith(7)
    expect(last().trackReplies()).toEqual([{ type: 'track', id: 't1', result: TRACK }])
    // A track request is none of its siblings, nor answered twice.
    expect(last().voyagesReplies()).toHaveLength(0)
    expect(last().snapshotsReplies()).toHaveLength(0)
    expect(last().historyReplies()).toHaveLength(0)

    live.stop()
  })

  it('sends back a reason when the store cannot read the path, rather than silence', async () => {
    const onTrackQuery = vi.fn().mockRejectedValue(new Error('/var/db/raw unreadable'))
    const { live, last } = uplink({ onTrackQuery })
    live.start()
    last().open()

    last().say(JSON.stringify({ type: 'track', id: 't2', voyageId: 7 }))
    await flush()

    // A fixed message, not the caught error's text: that text can hold a data-dir path.
    expect(last().trackReplies()).toEqual([
      { type: 'track', id: 't2', error: { code: 'TRACK_FAILED', message: 'track query failed' } }
    ])

    live.stop()
  })

  it('acts on nothing else - a command wearing a voyage id is still not one', async () => {
    const onTrackQuery = vi.fn().mockResolvedValue(TRACK)
    const { live, last } = uplink({ onTrackQuery })
    live.start()
    last().open()

    // A command wearing the request's clothes: an id and a numeric voyageId, everything but the
    // type tag. The tag is the gate; if it ever stopped deciding, this is what would run.
    last().say(JSON.stringify({ type: 'put', id: 'evil', voyageId: 7 }))
    // And a track-tagged message whose voyage id is not a number is not one either.
    last().say(JSON.stringify({ type: 'track', id: 't3', voyageId: 'all' }))
    await flush()

    expect(onTrackQuery).not.toHaveBeenCalled()
    expect(last().trackReplies()).toHaveLength(0)

    live.stop()
  })

  it('does nothing with a track request when the feature is not wired', async () => {
    const { live, last } = uplink() // no onTrackQuery
    live.start()
    last().open()

    last().say(JSON.stringify({ type: 'track', id: 't1', voyageId: 7 }))
    await flush()

    expect(last().trackReplies()).toHaveLength(0)

    live.stop()
  })
})

describe('the fifth sibling the shore may say: asking for her phases', () => {
  const PHASES: PhaseListResult = {
    phases: [
      {
        kind: 'anchored',
        start_ts: 1_752_400_000_000,
        end_ts: 1_752_410_000_000,
        start_lat: 43.5,
        start_lon: 7.0,
        end_lat: 43.5,
        end_lon: 7.0
      }
    ]
  }

  it('answers her phases, tagged with the id that asked, and the count reaches the store', async () => {
    const onPhasesQuery = vi.fn().mockResolvedValue(PHASES)
    const { live, last } = uplink({ onPhasesQuery })
    live.start()
    last().open()

    last().say(JSON.stringify({ type: 'phases', id: 'p1', limit: 50 }))
    await flush()

    expect(onPhasesQuery).toHaveBeenCalledWith(50)
    expect(last().phasesReplies()).toEqual([{ type: 'phases', id: 'p1', result: PHASES }])
    // A phases request is none of its siblings, nor answered twice.
    expect(last().voyagesReplies()).toHaveLength(0)
    expect(last().trackReplies()).toHaveLength(0)

    live.stop()
  })

  it('sends back a reason when the store cannot list them, rather than silence', async () => {
    const onPhasesQuery = vi.fn().mockRejectedValue(new Error('/var/db/phases.json unreadable'))
    const { live, last } = uplink({ onPhasesQuery })
    live.start()
    last().open()

    last().say(JSON.stringify({ type: 'phases', id: 'p2', limit: 50 }))
    await flush()

    // A fixed message, not the caught error's text: that text can hold a data-dir path, and this
    // reply crosses the wire to the shore.
    expect(last().phasesReplies()).toEqual([
      { type: 'phases', id: 'p2', error: { code: 'PHASES_FAILED', message: 'phases query failed' } }
    ])

    live.stop()
  })

  it('acts on nothing else - a command wearing a phases count is still not one', async () => {
    const onPhasesQuery = vi.fn().mockResolvedValue(PHASES)
    const { live, last } = uplink({ onPhasesQuery })
    live.start()
    last().open()

    // A command in the request's clothes: id and a numeric limit, everything but the type tag.
    last().say(JSON.stringify({ type: 'put', id: 'evil', limit: 50 }))
    // And a phases-tagged message whose count is not a number is not one either.
    last().say(JSON.stringify({ type: 'phases', id: 'p3', limit: 'all' }))
    await flush()

    expect(onPhasesQuery).not.toHaveBeenCalled()
    expect(last().phasesReplies()).toHaveLength(0)

    live.stop()
  })

  it('does nothing with a phases request when the feature is not wired', async () => {
    const { live, last } = uplink() // no onPhasesQuery
    live.start()
    last().open()

    last().say(JSON.stringify({ type: 'phases', id: 'p1', limit: 50 }))
    await flush()

    expect(last().phasesReplies()).toHaveLength(0)

    live.stop()
  })
})
