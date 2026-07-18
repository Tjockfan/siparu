/**
 * What the boat tells the relay about herself, and what she refuses to accept back.
 *
 * The load-bearing field is the TOKEN she already holds, sent as a bearer on
 * /pair/start. It is the only thing that lets a re-pairing land on the vessel that
 * already exists, because it is the only thing an attacker cannot produce: her mmsi is
 * public and proves nothing. Drop the token and every reinstall leaves the owner another
 * dead duplicate; trust the urn instead and a phished code hands her boat away.
 *
 * The other half is refusal. An approval that comes back naming a DIFFERENT boat means
 * the account that claimed the code does not own her, and adopting it would aim this
 * vessel's feed at a stranger. Both are pinned below.
 */
import type { IRouter, Request, Response } from 'express'
import type { ServerAPI } from '@signalk/server-api'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { __resetPairingState, maskEmail, registerPairRoutes, RemoteState } from '../src/pairing'
import type { UplinkStatus } from '../src/uplink'

type Handler = (req: Request, res: Response) => void

const app = {
  debug: () => {},
  error: () => {}
} as unknown as ServerAPI

const PAIRED: RemoteState = {
  boatId: 'boat-1',
  boatToken: 'the-token-she-already-holds',
  pairedEmail: 's***@example.com',
  pairedAt: '2026-07-01T00:00:00.000Z'
}

interface Opts {
  boatName?: string
  vesselUrn?: string
  remote?: RemoteState
  uplink?: UplinkStatus
  saved?: (r: RemoteState | undefined) => void
  pendingSaved?: (p: { boatToken: string; since: string } | undefined) => void
}

/** Registers the routes against a fake router and hands back the handlers. */
function routes(opts: Opts = {}) {
  const handlers = new Map<string, Handler>()
  const router = {
    get: (p: string, h: Handler) => handlers.set(`GET ${p}`, h),
    post: (p: string, h: Handler) => handlers.set(p, h)
  } as unknown as IRouter

  let remote = opts.remote
  let pending: { boatToken: string; since: string } | undefined
  registerPairRoutes(router, {
    app,
    relayUrl: 'https://relay.example',
    boatName: () => opts.boatName ?? 'Test Vessel',
    vesselUrn: () => opts.vesselUrn ?? 'urn:mrn:imo:mmsi:123456789',
    uplinkStatus: () => opts.uplink ?? null,
    getRemote: () => remote,
    saveRemote: async (r) => {
      remote = r
      opts.saved?.(r)
    },
    getPendingUnlink: () => pending,
    setPendingUnlink: async (p) => {
      pending = p
      opts.pendingSaved?.(p)
    }
  })
  return handlers
}

/** Calls a route and resolves once the handler has answered. */
function call(handlers: Map<string, Handler>, path: string): Promise<unknown> {
  return new Promise((resolve) => {
    const res = {
      json: (body: unknown) => resolve(body),
      status: () => res
    } as unknown as Response
    handlers.get(path)!({ body: {} } as Request, res)
  })
}

interface RelayCall {
  path: string
  body: Record<string, unknown>
  auth: string | null
}

/** Captures what the plugin sends to the relay, answering as the relay would. */
function relaySpy(): RelayCall[] {
  const sent: RelayCall[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body: string; headers: Record<string, string> }) => {
      const path = String(url).replace('https://relay.example', '')
      sent.push({
        path,
        body: JSON.parse(init.body) as Record<string, unknown>,
        auth: init.headers.authorization ?? null
      })
      const answer: Record<string, unknown> =
        path === '/pair/approve'
          ? { boat_id: 'boat-1', boat_token: 'a-fresh-token', claimed_by_email: 'skipper@example.com' }
          : { device_code: 'dc', user_code: 'WDJB-MJHT', expires_in: 3600 }
      return new Response(JSON.stringify(answer), { status: 200 })
    })
  )
  return sent
}

afterEach(() => {
  vi.unstubAllGlobals()
  __resetPairingState()
})

describe('pair/start', () => {
  it('reports the vessel urn, and carries no proof when she has never paired', async () => {
    const sent = relaySpy()

    await call(routes(), '/pair/start')

    expect(sent).toHaveLength(1)
    expect(sent[0].body).toEqual({
      boat_name: 'Test Vessel',
      vessel_urn: 'urn:mrn:imo:mmsi:123456789'
    })
    expect(sent[0].auth).toBeNull()
  })

  it('sends null rather than an empty string when Signal K knows neither name nor id', async () => {
    // A server told no MMSI and no UUID leaves selfId undefined. That is a real
    // configuration, not a hypothetical, and "" would look like an identity to the
    // relay while matching nothing.
    const sent = relaySpy()

    await call(routes({ boatName: '', vesselUrn: '' }), '/pair/start')

    expect(sent[0].body).toEqual({ boat_name: null, vessel_urn: null })
  })

  it('a paired boat re-pairs WITH her token, which is what keeps her one boat', async () => {
    // The urn in the body proves nothing (an mmsi is public). The token in the header
    // is the whole argument: only this vessel has it. Drop it and every reinstall
    // leaves the owner another dead duplicate.
    const sent = relaySpy()

    const body = await call(routes({ remote: PAIRED }), '/pair/start')

    expect(sent[0].auth).toBe(`Bearer ${PAIRED.boatToken}`)
    expect(body).toMatchObject({ state: 'showing_code' })
  })

  it('does not make her unlink first - that would throw the proof away', async () => {
    relaySpy()
    const body = (await call(routes({ remote: PAIRED }), '/pair/start')) as { state: string }
    expect(body.state).not.toBe('error')
  })
})

describe('pair/approve', () => {
  it('confirms the new token only AFTER it is safely on disk', async () => {
    // Order is the point. The relay leaves the old token alive until this confirmation
    // arrives, so that a boat which cannot write (a full Cerbo partition, issue #46) is
    // not cut off holding a token she never managed to keep.
    const order: string[] = []
    const sent = relaySpy()

    const handlers = routes({
      remote: PAIRED,
      saved: () => order.push('saved to disk')
    })
    await call(handlers, '/pair/start')
    await call(handlers, '/pair/approve')

    order.push(...sent.filter((c) => c.path === '/pair/confirm').map(() => 'confirmed to relay'))

    expect(order).toEqual(['saved to disk', 'confirmed to relay'])
    const confirm = sent.find((c) => c.path === '/pair/confirm')
    expect(confirm?.auth).toBe('Bearer a-fresh-token') // the NEW token, not the old one
  })

  it('says so plainly when the claimant does not own her, instead of "try again"', async () => {
    // The relay refuses a re-pairing claimed by an account that does not own her. That is
    // an answer, not a fault: telling the skipper to retry would have them hammering a
    // code that can never work while the real cause - wrong account - goes unsaid.
    let saved: RemoteState | undefined | 'untouched' = 'untouched'
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).endsWith('/pair/approve')
          ? new Response(JSON.stringify({ error: 'not_your_boat' }), { status: 409 })
          : new Response(
              JSON.stringify({ device_code: 'dc', user_code: 'WDJB-MJHT', expires_in: 3600 }),
              { status: 200 }
            )
      )
    )

    const handlers = routes({ remote: PAIRED, saved: (r) => (saved = r) })
    await call(handlers, '/pair/start')
    const body = (await call(handlers, '/pair/approve')) as { state: string; message: string }

    expect(body.message).toMatch(/does not own this boat/i)
    expect(body.message).not.toMatch(/try again/i)
    expect(saved).toBe('untouched') // she is still linked exactly as she was
  })

  it('REFUSES a boat that is not the one she is linked to, even if the relay offers it', async () => {
    // Belt and braces. The relay is what refuses this today, but a plugin that adopts
    // whatever comes back from an approval it asked for has no defence of its own - and
    // this is the hijack: adopt a stranger's boat and the vessel starts streaming to the
    // stranger's account, while her owner's boat goes dark holding a token nobody uses.
    let saved: RemoteState | undefined | 'untouched' = 'untouched'
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const answer = String(url).endsWith('/pair/approve')
          ? { boat_id: 'someone-elses-boat', boat_token: 'their-token', claimed_by_email: null }
          : { device_code: 'dc', user_code: 'WDJB-MJHT', expires_in: 3600 }
        return new Response(JSON.stringify(answer), { status: 200 })
      })
    )

    const handlers = routes({ remote: PAIRED, saved: (r) => (saved = r) })
    await call(handlers, '/pair/start')
    const body = (await call(handlers, '/pair/approve')) as { state: string; message: string }

    expect(body.state).toBe('error')
    expect(body.message).toMatch(/does not own this boat/i)
    expect(saved).toBe('untouched') // the stranger's token never reached the disk
  })

  it('still reports success when the confirmation cannot get through', async () => {
    // A confirmation that never lands is harmless: the old token simply lives longer.
    // Failing the pairing over it would be worse than the thing it protects against.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).endsWith('/pair/confirm')) throw new TypeError('fetch failed')
        return new Response(
          JSON.stringify(
            String(url).endsWith('/pair/approve')
              ? { boat_id: 'boat-1', boat_token: 'a-fresh-token', claimed_by_email: null }
              : { device_code: 'dc', user_code: 'WDJB-MJHT', expires_in: 3600 }
          ),
          { status: 200 }
        )
      })
    )

    const handlers = routes()
    await call(handlers, '/pair/start')

    expect(await call(handlers, '/pair/approve')).toMatchObject({ state: 'paired' })
  })
})

describe('pair/deny', () => {
  it('refusing a re-pairing leaves her paired, not unlinked', async () => {
    relaySpy()
    const handlers = routes({ remote: PAIRED })
    await call(handlers, '/pair/start')

    expect(await call(handlers, '/pair/deny')).toMatchObject({
      state: 'paired',
      boatId: PAIRED.boatId
    })
  })
})

describe('paired is not the same as streaming', () => {
  // The failure this guards against is silent and it is the worst one in the product:
  // the boat says "Remote viewing - on", the owner ashore sees a screen that has not
  // moved since Tuesday, and neither of them is told why. Whether her frames are
  // actually landing travels with the pairing state, on the same screen.
  it('carries the uplink state to the boat screen', async () => {
    const handlers = routes({
      remote: PAIRED,
      uplink: {
        lastSentTs: null,
        failures: 4,
        rejected: true,
        lastError: 'Siparu no longer recognises this boat. Pair her again.'
      }
    })

    expect(await call(handlers, 'GET /pair/status')).toMatchObject({
      state: 'paired',
      uplink: { rejected: true, failures: 4 }
    })
  })

  it('omits it while the plugin is still starting, rather than inventing one', async () => {
    const handlers = routes({ remote: PAIRED })
    const status = (await call(handlers, 'GET /pair/status')) as Record<string, unknown>

    expect(status.state).toBe('paired')
    expect(status.uplink).toBeUndefined()
  })
})

describe('what the skipper is told when it fails', () => {
  /** Answers /pair/start with a given status, as the relay would. */
  function relaySays(status: number, body = '{}') {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status })))
  }

  it('a refusal is not an outage: 429 says wait, not "check your internet"', async () => {
    // The uplink demonstrably works - the relay answered. Sending the owner to look at
    // DNS and captive portals would be a wrong diagnosis dressed up as a helpful one.
    relaySays(429, '{"error":"too_many_requests"}')

    const body = (await call(routes(), '/pair/start')) as { message: string }

    expect(body.message).toMatch(/wait an hour/i)
    expect(body.message).toMatch(/network/i)
    expect(body.message).not.toMatch(/captive portal|DNS/i)
  })

  it('a relay that never answers still reads as a connectivity problem', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      })
    )

    const body = (await call(routes(), '/pair/start')) as { message: string }

    expect(body.message).toMatch(/captive portal/i)
  })
})

describe('maskEmail', () => {
  it('shows enough to recognise yourself and not enough to harvest', () => {
    expect(maskEmail('skipper@example.com')).toBe('s***@example.com')
    expect(maskEmail(null)).toBeNull()
    expect(maskEmail('@example.com')).toBeNull()
  })
})
