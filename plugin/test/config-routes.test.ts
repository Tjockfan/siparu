/**
 * The fuel-paths config route: the one webapp write that is not pairing.
 *
 * It saves the plugin's own options (never the vessel bus - proved by the CI
 * read-only guards) and it is authorised like the rest of the server: open on
 * an unsecured server, admin-only on a secured one. These pin that posture, the
 * validation, and the merge that must not drop the boat's other settings.
 */
import { describe, expect, it } from 'vitest'
import type { IRouter } from 'express'
import type { ServerAPI } from '@signalk/server-api'
import { registerConfigRoutes } from '../src/config-routes'

interface Security {
  authenticationRequired: boolean
  allowConfigure: boolean
}

function fakeApp(sec: Security) {
  // What the route applied through restart(): the merged options it hands the
  // server to persist and re-start under. Deliberately no savePluginOptions here
  // - that persists without applying, and the route must not fall back to it, so
  // its absence makes such a regression throw rather than pass silently.
  const restarted: object[] = []
  const errors: string[] = []
  const app = {
    restarted,
    errors,
    error: (msg: string) => errors.push(msg),
    debug: () => undefined,
    securityStrategy: {
      getLoginStatus: () => ({ authenticationRequired: sec.authenticationRequired }),
      allowConfigure: () => sec.allowConfigure
    }
  }
  return app
}

function fakeRes() {
  const res = {
    _status: 200,
    _json: undefined as unknown,
    headersSent: false,
    status(code: number) {
      this._status = code
      return this
    },
    json(body: unknown) {
      this._json = body
      this.headersSent = true
      return this
    }
  }
  return res
}

const NO_VIEW = () => ({ available: [] as string[], selected: [] as string[] })

/** Register, capture the handlers, and expose a way to drive each verb. */
function mount(app: ReturnType<typeof fakeApp>, config: object, view = NO_VIEW) {
  const handlers: Record<string, (req: unknown, res: unknown) => void> = {}
  const router = {
    get: (_p: string, h: (req: unknown, res: unknown) => void) => {
      handlers.get = h
    },
    post: (_p: string, h: (req: unknown, res: unknown) => void) => {
      handlers.post = h
    }
  } as unknown as IRouter
  registerConfigRoutes(router, {
    app: app as unknown as ServerAPI,
    getConfig: () => config,
    fuelPathsView: view,
    restart: (configuration: object) => app.restarted.push(configuration)
  })
  return handlers
}

/** POST the body, then flush the async handler + savePluginOptions callback. */
async function post(app: ReturnType<typeof fakeApp>, config: object, body: unknown) {
  const res = fakeRes()
  // `body` present as an object short-circuits the stream read in readJsonBody.
  mount(app, config).post({ body } as unknown, res as unknown)
  await new Promise((r) => setImmediate(r))
  return res
}

const SECURED_ADMIN: Security = { authenticationRequired: true, allowConfigure: true }
const SECURED_GUEST: Security = { authenticationRequired: true, allowConfigure: false }
const UNSECURED: Security = { authenticationRequired: false, allowConfigure: false }

describe('the fuel-paths route is authorised like the server itself', () => {
  it('an admin on a secured server may set the paths', async () => {
    const app = fakeApp(SECURED_ADMIN)
    const res = await post(app, { boatName: 'X' }, { paths: ['propulsion.engine.fuel.rate'] })
    expect(res._status).toBe(200)
    expect(res._json).toEqual({ fuelRatePaths: ['propulsion.engine.fuel.rate'] })
    expect(app.restarted).toHaveLength(1)
  })

  it('an unsecured server is open, the same call pairing makes', async () => {
    const app = fakeApp(UNSECURED)
    const res = await post(app, {}, { paths: ['propulsion.port.fuel.rate'] })
    expect(res._status).toBe(200)
    expect(app.restarted).toHaveLength(1)
  })

  it('a non-admin on a secured server is refused, and nothing is saved', async () => {
    const app = fakeApp(SECURED_GUEST)
    const res = await post(app, {}, { paths: ['propulsion.port.fuel.rate'] })
    expect(res._status).toBe(403)
    expect(app.restarted).toHaveLength(0)
  })

  it('applies the selection now by restarting, not by persisting alone', async () => {
    // The bug this guards, caught in live smoke: savePluginOptions writes disk
    // but leaves the running plugin on the old paths, so a save looks accepted
    // yet counts the old fuel until the boat restarts. The route must go through
    // restart(), which persists and then stops+starts to apply.
    const app = fakeApp(UNSECURED)
    const res = await post(app, {}, { paths: ['propulsion.port.fuel.rate'] })
    expect(res._status).toBe(200)
    expect(app.restarted).toEqual([{ fuelRatePaths: ['propulsion.port.fuel.rate'] }])
  })
})

describe('the fuel-paths route validates and merges', () => {
  it('rejects a body that is not an array of strings', async () => {
    const app = fakeApp(SECURED_ADMIN)
    expect((await post(app, {}, { paths: 'nope' }))._status).toBe(400)
    expect((await post(app, {}, { paths: [1, 2] }))._status).toBe(400)
    expect((await post(app, {}, {}))._status).toBe(400)
    expect(app.restarted).toHaveLength(0)
  })

  it('trims blanks and empties, like resolveOptions does on read', async () => {
    const app = fakeApp(SECURED_ADMIN)
    await post(app, {}, { paths: ['  propulsion.port.fuel.rate  ', '', '   ', 'propulsion.engine.fuel.rate'] })
    expect((app.restarted[0] as { fuelRatePaths: string[] }).fuelRatePaths).toEqual([
      'propulsion.port.fuel.rate',
      'propulsion.engine.fuel.rate'
    ])
  })

  it('preserves every other setting and never writes the relay token back to options', async () => {
    const app = fakeApp(SECURED_ADMIN)
    const config = {
      boatName: 'Demo',
      ports: [{ name: 'Home', latitude: 58, longitude: 9, radiusNm: 4 }],
      remote: { boatId: 'b', boatToken: 'secret' }
    }
    await post(app, config, { paths: ['propulsion.port.fuel.rate'] })
    const applied = app.restarted[0] as Record<string, unknown>
    expect(applied.boatName).toBe('Demo')
    expect(applied.ports).toEqual(config.ports)
    expect(applied.fuelRatePaths).toEqual(['propulsion.port.fuel.rate'])
    // The token belongs in the data dir, never in the options the config route serves.
    expect('remote' in applied).toBe(false)
  })
})

describe('the fuel-paths route reads what the picker needs', () => {
  it('reports the reporting fuel paths and the current selection, open to read', () => {
    const app = fakeApp(SECURED_GUEST) // a reader is not a writer; GET is still open
    const view = () => ({
      available: ['propulsion.engine.fuel.rate', 'propulsion.port.fuel.rate'],
      selected: ['propulsion.engine.fuel.rate']
    })
    const res = fakeRes()
    mount(app, {}, view).get({} as unknown, res as unknown)
    expect(res._json).toEqual({
      available: ['propulsion.engine.fuel.rate', 'propulsion.port.fuel.rate'],
      selected: ['propulsion.engine.fuel.rate']
    })
  })
})
