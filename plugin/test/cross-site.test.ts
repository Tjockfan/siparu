/**
 * The routes that change something, held against a page in somebody else's tab.
 *
 * Signal K's default is security off, and it answers every request with
 * `Access-Control-Allow-Origin: *` alongside `Access-Control-Allow-Credentials: true`.
 * Measured on a running server, not read off the source. So any page open in any
 * browser on the boat's network - an advert frame in a marina wifi portal is enough -
 * could POST /pair/reset and cut her link, or read /pair/status, lift the pairing code
 * off the helm screen and claim it into an account of its own. None of it has to be
 * guessed, and the owner sees nothing.
 *
 * These tests call the routes the way the product registers them, through the same
 * register* functions index.ts uses. A guard tested by calling the guard proves the
 * guard compiles; what matters is whether the wiring puts it in front of the handler,
 * and that only shows here.
 *
 * Every case sets up a server with security OFF, which is the one where these routes
 * answer at all. Without that the refusal below would be the admin gate talking and
 * these tests would pass with no cross-site guard in the codebase.
 */
import type { IRouter, Request, Response } from 'express'
import type { ServerAPI } from '@signalk/server-api'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { __resetPairingState, registerPairRoutes, RemoteState } from '../src/pairing'
import { registerConfigRoutes } from '../src/config-routes'
import { registerVoyageEditRoutes } from '../src/voyage-routes'

type Handler = (req: Request, res: Response) => void

/**
 * A server running the way most of them run: no login, no principals. This is what
 * makes the write routes reachable in the first place - and what leaves them reachable
 * by a stranger's page too.
 */
const openServer = {
  debug: () => {},
  error: () => {},
  securityStrategy: {
    getLoginStatus: () => ({ authenticationRequired: false }),
    allowConfigure: () => false
  }
} as unknown as ServerAPI

const PAIRED: RemoteState = {
  boatId: 'boat-1',
  boatToken: 'the-token-she-already-holds',
  pairedEmail: 's***@example.com',
  pairedAt: '2026-07-01T00:00:00.000Z'
}

/** The boat's own screen, as the browser marks it. */
const OWN_SCREEN = { 'sec-fetch-site': 'same-origin', host: 'venus.local:3000' }

/** A page on the open internet, in a tab on the same boat network. */
const STRANGERS_PAGE = {
  'sec-fetch-site': 'cross-site',
  origin: 'https://reader.example',
  host: 'venus.local:3000'
}

interface Recorded {
  relay: string[]
  saved: Array<RemoteState | undefined>
  restarted: number
  merged: number[]
}

/**
 * Registers all three write-bearing routers against one fake router, and hands back
 * the handlers plus a record of everything a route would have changed.
 */
function boat(): { handlers: Map<string, Handler>; did: Recorded } {
  const handlers = new Map<string, Handler>()
  const router = {
    get: (p: string, h: Handler) => handlers.set(`GET ${p}`, h),
    post: (p: string, h: Handler) => handlers.set(p, h)
  } as unknown as IRouter

  const did: Recorded = { relay: [], saved: [], restarted: 0, merged: [] }

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      did.relay.push(String(url).replace('https://relay.example', ''))
      return new Response(
        JSON.stringify({
          device_code: 'dc',
          user_code: 'WDJB-MJHT',
          expires_in: 3600,
          boat_id: 'boat-1',
          boat_token: 'a-fresh-token',
          claimed_by_email: 'skipper@example.com',
          status: 'showing_code'
        }),
        { status: 200 }
      )
    })
  )

  let remote: RemoteState | undefined = PAIRED
  registerPairRoutes(router, {
    app: openServer,
    relayUrl: 'https://relay.example',
    // The owner has accepted the open network: this file is about origin
    // semantics, and the write lock (pinned in pair-security-warning.test.ts)
    // would otherwise refuse every call before sameOrigin is even consulted.
    acceptOpenNetwork: () => true,
    boatName: () => 'Test Vessel',
    vesselUrn: () => 'urn:mrn:imo:mmsi:123456789',
    uplinkStatus: () => null,
    getRemote: () => remote,
    saveRemote: async (r) => {
      remote = r
      did.saved.push(r)
    },
    getPendingUnlinks: () => [],
    addPendingUnlink: async () => {}
  })

  registerConfigRoutes(router, {
    app: openServer,
    acceptOpenNetwork: () => true,
    getConfig: () => ({}),
    fuelPathsView: () => ({ available: ['propulsion.port.fuel.rate'], selected: [] }),
    restart: () => {
      did.restarted += 1
    }
  })

  registerVoyageEditRoutes(router, {
    app: openServer,
    edits: () => ({ merged: [] }),
    mergeWithPrevious: async (id) => {
      did.merged.push(id)
      return { ok: true, voyage: { id } } as never
    },
    undoMerge: async (id) => {
      did.merged.push(id)
      return { ok: true, voyage: { id } } as never
    }
  })

  return { handlers, did }
}

interface Answer {
  status: number
  body: unknown
}

/** Calls a route with the headers a given caller would send, and waits for its answer. */
function call(
  handlers: Map<string, Handler>,
  path: string,
  headers: Record<string, string>,
  params: Record<string, string> = {}
): Promise<Answer> {
  return new Promise((resolve) => {
    let status = 200
    const res = {
      json: (body: unknown) => resolve({ status, body }),
      status: (s: number) => {
        status = s
        return res
      }
    } as unknown as Response
    handlers.get(path)!({ headers, params, body: {} } as unknown as Request, res)
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  __resetPairingState()
})

describe("a stranger's page, in a tab on the boat's network", () => {
  it('cannot unpair her: the link survives and the relay is never told', async () => {
    const { handlers, did } = boat()

    const answer = await call(handlers, '/pair/reset', STRANGERS_PAGE)

    expect(answer.status).toBe(403)
    expect(did.saved).toEqual([])
    expect(did.relay).toEqual([])
  })

  it.each(['/pair/start', '/pair/approve', '/pair/deny'])(
    'cannot drive %s, and the relay hears nothing',
    async (path) => {
      const { handlers, did } = boat()

      const answer = await call(handlers, path, STRANGERS_PAGE)

      expect(answer.status).toBe(403)
      expect(did.relay).toEqual([])
    }
  )

  it('cannot read the pairing screen, which is where the code is', async () => {
    const { handlers } = boat()

    const answer = await call(handlers, 'GET /pair/status', STRANGERS_PAGE)

    expect(answer.status).toBe(403)
    expect(JSON.stringify(answer.body)).not.toContain('boat-1')
  })

  it('cannot change which engine counts', async () => {
    const { handlers, did } = boat()

    const answer = await call(handlers, '/config/fuel-paths', STRANGERS_PAGE)

    expect(answer.status).toBe(403)
    expect(did.restarted).toBe(0)
  })

  it.each(['/voyages/:id/merge-previous', '/voyages/:id/undo-merge'])(
    'cannot rewrite the voyage record through %s',
    async (path) => {
      const { handlers, did } = boat()

      const answer = await call(handlers, path, STRANGERS_PAGE, { id: '7' })

      expect(answer.status).toBe(403)
      expect(did.merged).toEqual([])
    }
  )

  it('is refused even by an older browser, which sends Origin and no Sec-Fetch-Site', async () => {
    const { handlers, did } = boat()

    const answer = await call(handlers, '/pair/reset', {
      origin: 'https://reader.example',
      host: 'venus.local:3000'
    })

    expect(answer.status).toBe(403)
    expect(did.saved).toEqual([])
  })

  /**
   * Pinned separately because the two halves of the guard would otherwise cover for
   * each other: a page that sends Sec-Fetch-Site and no Origin (a cross-origin GET
   * the browser makes without one) must be refused on that header alone.
   */
  it.each(['cross-site', 'same-site'])(
    'is refused on the browser\'s own %s marking, with no Origin to compare',
    async (site) => {
      const { handlers, did } = boat()

      const answer = await call(handlers, '/pair/reset', {
        'sec-fetch-site': site,
        host: 'venus.local:3000'
      })

      expect(answer.status).toBe(403)
      expect(did.saved).toEqual([])
    }
  )

  it('is refused when it hides its origin, which a sandboxed frame does', async () => {
    const { handlers, did } = boat()

    const answer = await call(handlers, '/pair/reset', { origin: 'null', host: 'venus.local:3000' })

    expect(answer.status).toBe(403)
    expect(did.saved).toEqual([])
  })
})

/**
 * The other half, and the reason this is a guard rather than a wall: everything the
 * boat's own screen does must still work, or the fix has taken the product with it.
 */
describe('the helm, and the tools on her own network', () => {
  it('still unpairs from the boat screen', async () => {
    const { handlers, did } = boat()

    const answer = await call(handlers, '/pair/reset', OWN_SCREEN)

    expect(answer.status).toBe(200)
    expect(did.saved).toEqual([undefined])
  })

  it('still starts a pairing from the boat screen', async () => {
    const { handlers, did } = boat()

    const answer = await call(handlers, '/pair/start', OWN_SCREEN)

    expect(answer.status).toBe(200)
    expect(did.relay).toEqual(['/pair/start'])
  })

  it('still reads the pairing screen from the boat screen', async () => {
    const { handlers } = boat()

    const answer = await call(handlers, 'GET /pair/status', OWN_SCREEN)

    expect(answer.status).toBe(200)
    expect(answer.body).toMatchObject({ state: 'paired', boatId: 'boat-1' })
  })

  it('lets a page typed into the address bar through, which sends site: none', async () => {
    const { handlers } = boat()

    const answer = await call(handlers, 'GET /pair/status', {
      'sec-fetch-site': 'none',
      host: 'venus.local:3000'
    })

    expect(answer.status).toBe(200)
  })

  it('lets an older browser through when the Origin is the boat herself', async () => {
    const { handlers, did } = boat()

    const answer = await call(handlers, '/pair/start', {
      origin: 'http://venus.local:3000',
      host: 'venus.local:3000'
    })

    expect(answer.status).toBe(200)
    expect(did.relay).toEqual(['/pair/start'])
  })

  /**
   * curl, a script, Node-RED. No browser headers at all, and nothing to check: a caller
   * that reaches this port without a browser is already on the boat's network, where
   * `GET /plugins/siparu/config` hands over the token in one request. Refusing here
   * would cost the owner their own tooling and cost an intruder nothing.
   */
  it('lets a caller with no browser headers through, because it is not a browser', async () => {
    const { handlers, did } = boat()

    const answer = await call(handlers, '/pair/start', {})

    expect(answer.status).toBe(200)
    expect(did.relay).toEqual(['/pair/start'])
  })
})
