import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteLink } from '../src/config'
import { reportedStatus, Uplink, UplinkStatus } from '../src/uplink'

/**
 * The uplink is the only part of the plugin that talks to the outside world on a
 * timer, so what is tested here is mostly its restraint: what it does when the relay
 * is not there, when the relay says no, and when the boat has not been paired at all.
 */

const REMOTE: RemoteLink = {
  boatId: 'boat-1',
  boatToken: 'tok-secret',
  pairedEmail: 'o***@example.com',
  pairedAt: '2026-07-13T04:00:00.000Z'
}

const INTERVAL = 60_000

/** Whatever the relay is told to answer, and a record of what it was sent. */
function relayAnswers(...answers: Array<Response | Error>) {
  const calls: Array<{ url: string; token: string | null; body: unknown }> = []
  let i = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const headers = init.headers as Record<string, string> | undefined
      calls.push({
        url: String(url),
        token: headers?.authorization ?? null,
        body: JSON.parse(String(init.body ?? 'null'))
      })
      const answer = answers[Math.min(i++, answers.length - 1)]
      if (answer instanceof Error) throw answer
      return answer
    })
  )
  return calls
}

const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 })
const refused = (status: number) => () =>
  new Response(JSON.stringify({ error: 'unknown_token' }), { status })

function uplink(over: Partial<Parameters<typeof Uplink.prototype.constructor>[0]> = {}) {
  return new Uplink({
    relayUrl: 'https://relay.example',
    getRemote: () => REMOTE,
    frame: () => ({ ts: 1_752_400_000_000, lat: 43.5, lon: 7.0, sog: 3.2 }),
    debug: () => {},
    intervalMs: INTERVAL,
    ...over
  })
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('a paired boat', () => {
  it('sends her frame to the relay, signed with the token she was given', async () => {
    const calls = relayAnswers(ok())
    const up = uplink()
    up.start()

    await vi.advanceTimersByTimeAsync(INTERVAL)

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://relay.example/telemetry')
    expect(calls[0].token).toBe('Bearer tok-secret')
    expect(calls[0].body).toMatchObject({ lat: 43.5, sog: 3.2 })
    expect(up.status()).toMatchObject({ failures: 0, rejected: false })
    expect(up.status().lastSentTs).not.toBeNull()

    up.stop()
  })

  it('keeps sending, one frame per interval', async () => {
    const calls = relayAnswers(ok())
    const up = uplink()
    up.start()

    await vi.advanceTimersByTimeAsync(INTERVAL * 3)

    expect(calls).toHaveLength(3)
    up.stop()
  })

  it('sends nothing at all before the first interval elapses', async () => {
    const calls = relayAnswers(ok())
    const up = uplink()
    up.start()

    await vi.advanceTimersByTimeAsync(INTERVAL - 1)

    expect(calls).toHaveLength(0)
    up.stop()
  })
})

describe('a boat that was never paired', () => {
  it('never calls the relay, and does not need to be restarted once she is paired', async () => {
    const calls = relayAnswers(ok())
    let remote: RemoteLink | undefined
    const up = uplink({ getRemote: () => remote })
    up.start()

    await vi.advanceTimersByTimeAsync(INTERVAL * 2)
    expect(calls).toHaveLength(0)

    // Paired mid-passage, from the boat's own screen. The feed starts on the next tick.
    remote = REMOTE
    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(calls).toHaveLength(1)

    up.stop()
  })
})

describe('when the relay cannot be reached', () => {
  it('counts the failure and says something a skipper can act on', async () => {
    relayAnswers(new Error('fetch failed'))
    const up = uplink()
    up.start()

    await vi.advanceTimersByTimeAsync(INTERVAL)

    expect(up.status()).toMatchObject({
      failures: 1,
      rejected: false,
      lastError: 'Cannot reach Siparu. Is the boat online?'
    })
    up.stop()
  })

  it('backs off, so a fortnight in an anchorage is not a fortnight of hammering', async () => {
    const calls = relayAnswers(new Error('fetch failed'))
    const up = uplink()
    up.start()

    // One missed frame is a squall passing over the dish, not an outage. She retries on
    // the normal cadence.
    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(calls).toHaveLength(2)

    // Two in a row is an outage, and now the interval doubles: nothing at three
    // minutes, the third attempt at four.
    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(calls).toHaveLength(3)

    up.stop()
  })

  it('never backs off past the ceiling, so she comes back within the quarter hour', async () => {
    const calls = relayAnswers(new Error('fetch failed'))
    const up = uplink()
    up.start()

    // Two hours offline: the interval doubles up to fifteen minutes and stops there.
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000)
    const attemptsAfterTwoHours = calls.length

    await vi.advanceTimersByTimeAsync(16 * 60_000)
    expect(calls.length).toBeGreaterThan(attemptsAfterTwoHours)

    up.stop()
  })

  it('picks straight back up the moment the uplink returns', async () => {
    const calls = relayAnswers(new Error('fetch failed'), ok())
    const up = uplink()
    up.start()

    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(up.status().failures).toBe(1)

    await vi.advanceTimersByTimeAsync(INTERVAL) // the retry, which succeeds
    expect(up.status()).toMatchObject({ failures: 0, lastError: null })

    // And she is back on the normal cadence, not still counting old failures.
    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(calls).toHaveLength(3)

    up.stop()
  })
})

describe('when the relay refuses the token', () => {
  it('says so plainly - the owner is watching a screen that will never update', async () => {
    relayAnswers(refused(401)())
    const up = uplink()
    up.start()

    await vi.advanceTimersByTimeAsync(INTERVAL)

    expect(up.status()).toMatchObject({
      rejected: true,
      lastError: 'Siparu no longer recognises this boat. Pair her again.'
    })
    up.stop()
  })

  it('does NOT unpair the boat, and keeps knocking', async () => {
    // A 401 from a bad deploy or a half-applied migration would otherwise unpair every
    // vessel in the fleet at once, and every owner would have to walk down to the boat
    // to fix a bug that was ours. She holds her token and comes back on her own.
    const calls = relayAnswers(refused(401)(), refused(401)(), ok())
    const up = uplink()
    up.start()

    await vi.advanceTimersByTimeAsync(60 * 60_000)

    expect(calls.length).toBeGreaterThanOrEqual(3)
    expect(calls.every((c) => c.token === 'Bearer tok-secret')).toBe(true)
    expect(up.status()).toMatchObject({ rejected: false, failures: 0 })

    up.stop()
  })

  it('treats a rejected frame as a failure but not as a rejection', async () => {
    relayAnswers(new Response(JSON.stringify({ error: 'bad_state' }), { status: 400 }))
    const up = uplink()
    up.start()

    await vi.advanceTimersByTimeAsync(INTERVAL)

    expect(up.status()).toMatchObject({ rejected: false, failures: 1 })
    expect(up.status().lastError).toContain('400')
    up.stop()
  })
})

describe('stopping', () => {
  it('does not resurrect itself when stopped mid-flight', async () => {
    // The bug this pins: stop() lands while a frame is in the air. The abort rejects
    // the fetch, the rejection walks back into tick(), and a naive tick() reschedules -
    // so the stopped instance keeps sending forever, next to the one that replaced it,
    // on a token that may already be stale. Signal K restarts plugins on every config
    // save, so a save during an in-flight request is the ordinary way to hit this.
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit = {}) =>
          new Promise((_resolve, reject) => {
            calls++
            // Never resolves on its own: the only way out is the abort from stop().
            ;(init.signal as AbortSignal | undefined)?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError'))
            )
          })
      )
    )

    const up = uplink()
    up.start()
    await vi.advanceTimersByTimeAsync(INTERVAL) // tick fires; the fetch is now hanging
    expect(calls).toBe(1)

    up.stop() // aborts the in-flight request
    await vi.advanceTimersByTimeAsync(0) // let the rejection propagate through tick()

    // A resurrected uplink would schedule again and fire on the next interval.
    await vi.advanceTimersByTimeAsync(INTERVAL * 5)
    expect(calls).toBe(1)
  })

  it('sends nothing afterwards - Signal K restarts plugins on every config save', async () => {
    const calls = relayAnswers(ok())
    const up = uplink()
    up.start()

    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(calls).toHaveLength(1)

    up.stop()
    await vi.advanceTimersByTimeAsync(INTERVAL * 5)

    expect(calls).toHaveLength(1)
  })

  it('forgets the previous pairing when a new one lands', async () => {
    relayAnswers(refused(401)())
    const up = uplink()
    up.start()
    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(up.status().rejected).toBe(true)

    up.reset()

    expect(up.status()).toEqual({
      lastSentTs: null,
      failures: 0,
      rejected: false,
      lastError: null
    })
    up.stop()
  })
})

describe('while the live socket is carrying her', () => {
  it('sends nothing: the same position, later, paid for twice', async () => {
    const calls = relayAnswers(ok())
    const up = uplink({ liveHealthy: () => true })
    up.start()

    await vi.advanceTimersByTimeAsync(INTERVAL * 3)
    expect(calls).toHaveLength(0)

    up.stop()
  })

  it('takes over the moment the socket stops being healthy', async () => {
    const calls = relayAnswers(ok())
    let live = true
    const up = uplink({ liveHealthy: () => live })
    up.start()

    await vi.advanceTimersByTimeAsync(INTERVAL * 2)
    expect(calls).toHaveLength(0)

    // The socket dropped. The timer was still running precisely so that this needs nobody to
    // notice it and start anything - the very next tick carries her.
    live = false
    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(calls).toHaveLength(1)

    up.stop()
  })
})

describe('what the boat says about herself', () => {
  const post = (over: Partial<UplinkStatus> = {}): UplinkStatus => ({
    lastSentTs: null,
    failures: 0,
    rejected: false,
    lastError: null,
    ...over
  })

  it('speaks for the socket while the socket is carrying her', () => {
    // The POST path has never sent anything - it does not need to, the socket is up. Reporting
    // ITS state would tell an owner her boat has never sent a frame, while it is streaming to
    // her twice a second.
    const s = reportedStatus({ connected: true, lastFrameTs: 1_752_400_000_000 }, post())
    expect(s?.lastSentTs).toBe(1_752_400_000_000)
    expect(s?.lastError).toBeNull()
  })

  it('does not carry the failures of a path that is not being used', () => {
    // She was offline; the POST path piled up failures. Then the socket came up and took over,
    // and the POST path stopped trying - so its counter is frozen, not current. Left alone it
    // would say "Cannot reach Siparu" forever, about a boat that is plainly getting through.
    const stale = post({ failures: 3, lastError: 'Cannot reach Siparu. Is the boat online?' })
    const s = reportedStatus({ connected: true, lastFrameTs: 1_752_400_000_000 }, stale)
    expect(s?.failures).toBe(0)
    expect(s?.lastError).toBeNull()
  })

  it('speaks for the POST path the moment the socket is not connected', () => {
    const dialling = reportedStatus({ connected: false, lastFrameTs: null }, post({ failures: 2 }))
    expect(dialling?.failures).toBe(2)
  })

  it('says nothing at all when the boat is not running', () => {
    expect(reportedStatus(null, null)).toBeNull()
  })
})
