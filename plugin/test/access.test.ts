/**
 * Read routes declare themselves readable where the server lets them, and go in
 * as before where it does not. The write routes never come near the readable
 * registrar: on every server they keep the default, which is admin-only.
 */
import type { IRouter } from 'express'
import { describe, expect, it, vi } from 'vitest'
import type { ServerAPI } from '@signalk/server-api'
import { readable } from '../src/access'
import { registerRoutes } from '../src/rest'
import { registerPairRoutes } from '../src/pairing'
import { registerConfigRoutes } from '../src/config-routes'
import { registerVoyageEditRoutes } from '../src/voyage-routes'

/**
 * A router the way signalk-server 2.31+ hands it over: access() on the side.
 * The fake reads `this`, which the server's own implementation does not, so a
 * detached call loses the registrar here and the test says so.
 */
function newRouter() {
  const direct = { get: vi.fn(), post: vi.fn() }
  const ro = { get: vi.fn() }
  const access = vi.fn(function (this: { ro: typeof ro }, _level: string) {
    return this?.ro
  })
  const router = { ...direct, ro, access } as unknown as IRouter
  return { router, direct, ro, access }
}

/** A router the way an older server hands it over: plain Express. */
function oldRouter() {
  const direct = { get: vi.fn(), post: vi.fn() }
  return { router: direct as unknown as IRouter, direct }
}

const app = {} as ServerAPI
const pairDeps = {
  app,
  relayUrl: 'https://relay.invalid',
  acceptOpenNetwork: () => false,
  boatName: () => 'x',
  uplinkStatus: () => null,
  vesselUrn: () => '',
  getRemote: () => undefined,
  saveRemote: async () => {},
  getPendingUnlinks: () => [],
  addPendingUnlink: async () => {},
  saveAnchor: async () => {}
}

describe('readable()', () => {
  it('asks the server for the readonly level and hands back its registrar', () => {
    const { router, ro, access } = newRouter()
    expect(readable(router)).toBe(ro)
    expect(access).toHaveBeenCalledWith('readonly')
  })

  it('falls back to the router itself where the server offers no access()', () => {
    const { router } = oldRouter()
    expect(readable(router)).toBe(router)
  })

  it('ignores an access() that answers with nothing usable', () => {
    const router = { get: vi.fn(), access: () => undefined } as unknown as IRouter
    expect(readable(router)).toBe(router)
  })
})

describe('which routes are readable', () => {
  it('every rest.ts route is registered through the readable registrar, none directly', () => {
    const { router, direct, ro } = newRouter()
    registerRoutes(router)
    expect(ro.get).toHaveBeenCalled()
    expect(direct.get).not.toHaveBeenCalled()
    expect(direct.post).not.toHaveBeenCalled()
    const paths = ro.get.mock.calls.map((c) => c[0])
    expect(paths).toEqual(expect.arrayContaining(['/live', '/health', '/voyages', '/charts/*']))
  })

  it('pairing: only /pair/status is readable; the four writes stay on the router', () => {
    const { router, direct, ro } = newRouter()
    registerPairRoutes(router, pairDeps as never)
    expect(ro.get.mock.calls.map((c) => c[0])).toEqual(['/pair/status'])
    expect(direct.get).not.toHaveBeenCalled()
    expect(direct.post.mock.calls.map((c) => c[0]).sort()).toEqual(
      ['/pair/approve', '/pair/deny', '/pair/reset', '/pair/start']
    )
  })

  it('fuel source and passage edits: the read is readable, the writes are not', () => {
    const { router, direct, ro } = newRouter()
    registerConfigRoutes(router, {
      app,
      acceptOpenNetwork: () => false,
      getConfig: () => ({}),
      fuelPathsView: () => ({}),
      restart: () => {}
    } as never)
    registerVoyageEditRoutes(router, {
      app,
      acceptOpenNetwork: () => false,
      edits: () => [],
      mergeWithPrevious: async () => ({ ok: true }),
      undoMerge: async () => ({ ok: true })
    } as never)
    expect(ro.get.mock.calls.map((c) => c[0]).sort()).toEqual(['/config/fuel-paths', '/voyages/edits'])
    expect(direct.get).not.toHaveBeenCalled()
    expect(direct.post.mock.calls.map((c) => c[0]).sort()).toEqual(
      ['/config/fuel-paths', '/voyages/:id/merge-previous', '/voyages/:id/undo-merge']
    )
  })

  it('on an older server the same reads go straight onto the router', () => {
    const { router, direct } = oldRouter()
    registerRoutes(router)
    registerPairRoutes(router, pairDeps as never)
    expect(direct.get.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(['/live', '/pair/status']))
  })
})
