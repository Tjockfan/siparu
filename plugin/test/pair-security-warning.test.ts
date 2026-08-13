/**
 * The warning on the door, and the lock behind it.
 *
 * Signal K ships with security off and nothing in the setup makes you turn it on.
 * With it off these routes would answer anyone on the boat's network: reset kills
 * the live token so the relay's not_your_boat guard cannot fire, start hands the
 * next code to whoever asked, and the owner's screen goes on saying "paired".
 *
 * So the defence is in two parts, both pinned here. The helm is TOLD, in every
 * screen state, and never on a server that is actually locked down. And the writes
 * REFUSE until the owner has answered for the open network in the plugin settings
 * (acceptOpenNetwork) - a refusal that must land before the relay is ever dialled,
 * so it has no side effects to roll back.
 */
import type { IRouter, Request, Response } from 'express'
import type { ServerAPI } from '@signalk/server-api'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { __resetPairingState, registerPairRoutes, RemoteState } from '../src/pairing'

type Handler = (req: Request, res: Response) => void
type Strategy = { getLoginStatus?: (req: unknown) => { authenticationRequired?: boolean } }

/** Signal K's own shapes: tokensecurity hardcodes true, the dummy answers false. */
const SECURED: Strategy = { getLoginStatus: () => ({ authenticationRequired: true }) }
const UNSECURED: Strategy = { getLoginStatus: () => ({ authenticationRequired: false }) }

const PAIRED: RemoteState = {
  boatId: 'boat-1',
  boatToken: 'the-token-she-already-holds',
  pairedEmail: 's***@example.com',
  pairedAt: '2026-07-01T00:00:00.000Z'
}

afterEach(() => {
  __resetPairingState()
})

/** The routes against a server with the given strategy, plus what they touched. */
function mount(strategy: Strategy | undefined, opts: { remote?: RemoteState; accept?: boolean } = {}) {
  const handlers = new Map<string, Handler>()
  const router = {
    get: (p: string, h: Handler) => handlers.set(`GET ${p}`, h),
    post: (p: string, h: Handler) => handlers.set(p, h)
  } as unknown as IRouter

  const app = { debug: () => {}, error: () => {}, securityStrategy: strategy } as unknown as ServerAPI
  const saved: Array<RemoteState | undefined> = []

  registerPairRoutes(router, {
    app,
    relayUrl: 'https://relay.example',
    acceptOpenNetwork: () => opts.accept ?? false,
    boatName: () => 'Test Vessel',
    vesselUrn: () => '',
    uplinkStatus: () => null,
    getRemote: () => opts.remote,
    saveRemote: async (r) => {
      saved.push(r)
    },
    getPendingUnlinks: () => [],
    addPendingUnlink: async () => undefined
  })

  const drive = (key: string): Promise<{ status: number; body: Record<string, unknown> }> =>
    new Promise((resolve) => {
      let code = 200
      const res = {
        status: (n: number) => {
          code = n
          return res
        },
        json: (body: unknown) => resolve({ status: code, body: body as Record<string, unknown> })
      } as unknown as Response
      handlers.get(key)!({ body: {} } as Request, res)
    })

  return { drive, saved }
}

/** GET /pair/status against a server with the given security strategy. */
async function status(
  strategy: Strategy | undefined,
  remote?: RemoteState,
  accept?: boolean
): Promise<Record<string, unknown>> {
  const { drive } = mount(strategy, { remote, accept })
  return (await drive('GET /pair/status')).body
}

describe('the security warning rides every state', () => {
  it('warns an unsecured server when idle, and says the door is locked', async () => {
    const body = await status(UNSECURED)
    expect(body.state).toBe('idle')
    expect(body.security_off).toBe(true)
    // The screen should explain a locked button, not let it be pressed and fail.
    expect(body.pairing_locked).toBe(true)
  })

  it('warns an unsecured server that is already paired', async () => {
    // The state that matters most: she is linked, the screen says all is well, and
    // anyone on the marina wifi would take her if the writes answered.
    const body = await status(UNSECURED, PAIRED)
    expect(body.state).toBe('paired')
    expect(body.security_off).toBe(true)
    expect(body.pairing_locked).toBe(true)
    // And the warning did not loosen anything: the token is still not on the wire.
    expect(JSON.stringify(body)).not.toContain(PAIRED.boatToken)
  })

  it('keeps warning once the owner has accepted, but reports the door unlocked', async () => {
    // Acceptance buys back the buttons, not silence: the server is still open,
    // and the helm should go on being told so.
    const body = await status(UNSECURED, PAIRED, true)
    expect(body.security_off).toBe(true)
    expect(body.pairing_locked).toBeUndefined()
  })

  it('stays silent on a secured server, paired or not', async () => {
    expect((await status(SECURED)).security_off).toBeUndefined()
    expect((await status(SECURED, PAIRED)).security_off).toBeUndefined()
  })

  it('stays silent when the strategy is absent or an unfamiliar shape', async () => {
    // securityStrategy is not in the server-api types and is read through a cast, so
    // an unrecognised server must read as secured. An alarm on every install is an
    // alarm nobody reads.
    expect((await status(undefined)).security_off).toBeUndefined()
    expect((await status({})).security_off).toBeUndefined()
    expect(
      (
        await status({
          getLoginStatus: () => {
            throw new Error('an older server')
          }
        })
      ).security_off
    ).toBeUndefined()
  })
})

describe('the lock on the writes', () => {
  const fetchSpy = () => {
    const spy = vi.fn(async () => {
      throw new Error('the relay must not be dialled by a refused write')
    })
    vi.stubGlobal('fetch', spy)
    return spy
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each([['/pair/start'], ['/pair/approve'], ['/pair/reset']])(
    'refuses %s on an unsecured server, before the relay is dialled',
    async (route) => {
      const spy = fetchSpy()
      const { drive, saved } = mount(UNSECURED, { remote: PAIRED })
      const { status: code, body } = await drive(route)
      expect(code).toBe(403)
      expect(body.state).toBe('error')
      expect(String(body.message)).toContain('security is off')
      // Refused means untouched: no relay call to roll back, no state moved.
      expect(spy).not.toHaveBeenCalled()
      expect(saved).toEqual([])
    }
  )

  it('lets /pair/start through once the owner has accepted the open network', async () => {
    // The gate, not the relay, is under test: a dialled relay is the proof the
    // gate opened, so the stub only records that the call was made.
    const spy = fetchSpy()
    const { drive } = mount(UNSECURED, { accept: true })
    const { status: code } = await drive('/pair/start')
    expect(spy).toHaveBeenCalled()
    // The stubbed relay throws, so the route answers 502 - which is the point:
    // it got past the lock and failed on the wire, not at the door.
    expect(code).toBe(502)
  })

  it('leaves /pair/deny open when locked: cancelling is not the takeover', async () => {
    // The dangerous cancellation is reset, and that is locked above. Deny only
    // abandons a pairing in progress, which a locked boat cannot even have.
    const { drive } = mount(UNSECURED, { remote: PAIRED })
    const { status: code, body } = await drive('/pair/deny')
    expect(code).toBe(200)
    expect(body.state).toBe('paired')
  })

  it('does not lock a secured server, whatever the setting says', async () => {
    const spy = fetchSpy()
    const { drive } = mount(SECURED, {})
    const { status: code } = await drive('/pair/start')
    // Straight past the gate to the (stubbed, failing) relay: the lock is about
    // an open door, and this door is not open.
    expect(spy).toHaveBeenCalled()
    expect(code).toBe(502)
  })
})
