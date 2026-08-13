import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteLink } from '../src/config'
import { LiveSocket, LiveUplink, isWatchingNote } from '../src/live'

/**
 * The one thing the relay says on its own account: that a screen ashore has opened.
 *
 * It exists because of a gap an owner walked into twice. A phone authorised on the account
 * cannot open a frame until this vessel re-reads the list of screens she seals to, and she
 * reads it on a five minute poll - so the phone shows nothing while she reports every couple
 * of seconds. The note names the one moment that gap is felt by a person, and she answers it
 * by asking a question she was going to ask anyway, sooner.
 *
 * What is pinned here is the shape of that: a note is not a question, it is not answered, it
 * does not reach the handlers that read her store, and it survives sealing - which is where
 * everything else in the clear stops.
 */

const REMOTE: RemoteLink = {
  boatId: 'boat-1',
  boatToken: 'tok-secret',
  pairedEmail: 'o***@example.com',
  pairedAt: '2026-08-02T04:00:00.000Z'
}

class FakeSocket implements LiveSocket {
  sent: string[] = []
  private handlers: Record<string, (...a: never[]) => void> = {}

  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {}
  terminate(): void {}
  onOpen(cb: () => void): void {
    this.handlers.open = cb as never
  }
  onMessage(cb: (data: string) => void): void {
    this.handlers.message = cb as never
  }
  onClose(): void {}
  onError(): void {}
  onRefused(): void {}

  open(): void {
    ;(this.handlers.open as (() => void) | undefined)?.()
  }
  say(msg: string): void {
    ;(this.handlers.message as ((d: string) => void) | undefined)?.(msg)
  }
  /** What she put on the wire that was not a frame or a keepalive. */
  replies(): unknown[] {
    return this.sent.filter((s) => s !== 'ping').slice(1).map((s) => JSON.parse(s))
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

function uplink(over: Partial<ConstructorParameters<typeof LiveUplink>[0]> = {}) {
  const sockets: FakeSocket[] = []
  const live = new LiveUplink({
    relayUrl: 'https://relay.example',
    getRemote: () => REMOTE,
    frame: () => ({ ts: 1_754_000_000_000, lat: 43.5, lon: 7.0, sog: 0 }),
    // She has no unsealed way onto the wire, here or in the product.
    seal: (frame) => ({ mode: 'sealed' as const, frame }),
    sealAnswer: (payload, id) => ({ mode: 'sealed' as const, frame: { id, payload } }),
    debug: () => {},
    connect: () => {
      const s = new FakeSocket()
      sockets.push(s)
      return s
    },
    ...over
  })
  return { live, last: () => sockets[sockets.length - 1] }
}

const WATCHING = JSON.stringify({ type: 'watching' })

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('the relay saying a screen ashore has opened', () => {
  it('tells the boat, so she may re-read who she seals to', () => {
    const watched = vi.fn()
    const { live, last } = uplink({ onWatching: watched })
    live.start()
    last().open()

    last().say(WATCHING)

    expect(watched).toHaveBeenCalledTimes(1)
  })

  it('is heard while she is sealing, where a question in the clear is not', async () => {
    // The branch that matters. Everything else arriving in the clear at a sealing boat is
    // refused or dropped, and a note routed through that branch would leave this closed in
    // exactly the state it was written for: sealed to a list that does not name the new screen.
    const watched = vi.fn()
    const { live, last } = uplink({
      openAsk: () => undefined,
      onWatching: watched
    })
    live.start()
    last().open()

    last().say(WATCHING)
    await flush()

    expect(watched).toHaveBeenCalledTimes(1)
    // And nothing went back: there is no question here to refuse and no answer to give.
    expect(last().replies()).toEqual([])
  })

  it('is answered with nothing at all', async () => {
    const { live, last } = uplink({ onWatching: () => {} })
    live.start()
    last().open()

    last().say(WATCHING)
    await flush()

    expect(last().replies()).toEqual([])
  })

  it('never reaches the handlers that read her store', async () => {
    // A note is not a question. If it fell through to the guards below, a message the shore
    // may send at will would be running reads of her disk.
    const store = vi.fn()
    const { live, last } = uplink({
      onWatching: () => {},
      onHistoryQuery: store as never,
      onSnapshotsQuery: store as never,
      onVoyagesQuery: store as never,
      onTrackQuery: store as never,
      onPhasesQuery: store as never,
      onAlertRulesQuery: store as never,
      onSetAlertRules: store as never
    })
    live.start()
    last().open()

    last().say(WATCHING)
    await flush()

    expect(store).not.toHaveBeenCalled()
  })

  it('leaves a boat wired without a handler exactly as she was', async () => {
    // An older build, or one assembled without this: the note is recognised, nothing is done
    // with it, and the socket carries on. Not an error and not a disconnect.
    const { live, last } = uplink()
    live.start()
    last().open()

    last().say(WATCHING)
    await flush()

    expect(last().replies()).toEqual([])
  })
})

describe('what counts as that note', () => {
  it('is recognised by its type and nothing else', () => {
    expect(isWatchingNote(JSON.stringify({ type: 'watching' }))).toBe(true)
    // Extra fields change nothing: there are no arguments to this, so there is nothing a
    // later relay - or anybody able to speak on the socket - could add that she would read.
    expect(isWatchingNote(JSON.stringify({ type: 'watching', boat: 'someone-else' }))).toBe(true)
  })

  it('is not confused with a question, a keepalive or junk', () => {
    expect(isWatchingNote(JSON.stringify({ type: 'history', id: 'x', path: 'p' }))).toBe(false)
    expect(isWatchingNote('pong')).toBe(false)
    expect(isWatchingNote('{')).toBe(false)
    expect(isWatchingNote(JSON.stringify(['watching']))).toBe(false)
    expect(isWatchingNote(JSON.stringify(null))).toBe(false)
  })
})
