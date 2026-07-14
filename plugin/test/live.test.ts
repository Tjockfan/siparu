import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteLink } from '../src/config'
import { FRAME_EVERY_MS, LiveSocket, LiveUplink, PING_EVERY_MS } from '../src/live'

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
