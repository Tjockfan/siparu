/**
 * The warning on the door.
 *
 * Signal K ships with security off and nothing in the setup makes you turn it on.
 * With it off these routes answer anyone on the boat's network, and a stranger can
 * link the vessel to their own account while the owner's screen says "paired".
 *
 * Pairing is still allowed on purpose: refusing it would stop the owner and not the
 * intruder, who has shorter ways into an unsecured server (`GET /config` hands over
 * the token in one request). So the whole of this defence is that the helm is told -
 * which means the telling has to survive every screen state, and must never fire on
 * a server that is actually locked down.
 */
import type { IRouter, Request, Response } from 'express'
import type { ServerAPI } from '@signalk/server-api'
import { afterEach, describe, expect, it } from 'vitest'
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

/** GET /pair/status against a server with the given security strategy. */
function status(strategy: Strategy | undefined, remote?: RemoteState): Promise<Record<string, unknown>> {
  const handlers = new Map<string, Handler>()
  const router = {
    get: (p: string, h: Handler) => handlers.set(`GET ${p}`, h),
    post: (p: string, h: Handler) => handlers.set(p, h)
  } as unknown as IRouter

  const app = { debug: () => {}, error: () => {}, securityStrategy: strategy } as unknown as ServerAPI

  registerPairRoutes(router, {
    app,
    relayUrl: 'https://relay.example',
    boatName: () => 'Test Vessel',
    vesselUrn: () => '',
    uplinkStatus: () => null,
    getRemote: () => remote,
    saveRemote: async () => undefined
  })

  return new Promise((resolve) => {
    const res = {
      json: (body: unknown) => resolve(body as Record<string, unknown>),
      status: () => res
    } as unknown as Response
    handlers.get('GET /pair/status')!({ body: {} } as Request, res)
  })
}

describe('the security warning rides every state', () => {
  it('warns an unsecured server when idle', async () => {
    const body = await status(UNSECURED)
    expect(body.state).toBe('idle')
    expect(body.security_off).toBe(true)
  })

  it('warns an unsecured server that is already paired', async () => {
    // The state that matters most: she is linked, the screen says all is well, and
    // anyone on the marina wifi can still take her.
    const body = await status(UNSECURED, PAIRED)
    expect(body.state).toBe('paired')
    expect(body.security_off).toBe(true)
    // And the warning did not loosen anything: the token is still not on the wire.
    expect(JSON.stringify(body)).not.toContain(PAIRED.boatToken)
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
