/**
 * REST param parsing & error mapping - the routes must answer bad input
 * with 400 JSON (never Express' HTML error page), clamp limits, and 503
 * before the plugin has started.
 */
import type { IRouter, Request, Response } from 'express'
import { afterEach, describe, expect, it } from 'vitest'
import { QueryError } from '../src/query'
import { RestDeps, registerRoutes, setRestDeps } from '../src/rest'

type Handler = (req: Request, res: Response) => void

function buildRoutes(): Map<string, Handler> {
  const routes = new Map<string, Handler>()
  const router = {
    get: (p: string, h: Handler) => {
      routes.set(p, h)
    }
  } as unknown as IRouter
  registerRoutes(router)
  return routes
}

/** Calls a route and resolves when the handler answers via res.json(). */
function call(
  routes: Map<string, Handler>,
  path: string,
  req: { query?: Record<string, unknown>; params?: Record<string, string> } = {}
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve) => {
    const out = { status: 200 }
    const res = {
      status(c: number) {
        out.status = c
        return res
      },
      json(body: unknown) {
        resolve({ status: out.status, body })
        return res
      }
    } as unknown as Response
    routes.get(path)!({ query: req.query ?? {}, params: req.params ?? {} } as unknown as Request, res)
  })
}

/** Full deps surface; individual tests override what they observe. */
function stubDeps(overrides: Partial<RestDeps> = {}): RestDeps {
  return {
    live: () => ({}),
    health: async () => ({}),
    snapshots: async () => ({ rows: [] }),
    voyages: async () => [],
    voyageCurrent: async () => null,
    voyageStats: async () => ({}),
    voyageTrack: async () => [],
    aisTargets: async () => ({ targets: [] }),
    rollupHours: async () => ({ rows: [] }),
    mapConfig: () => ({}),
    dataDir: () => '/nonexistent',
    ...overrides
  }
}

afterEach(() => {
  setRestDeps(null)
})

describe('REST routes', () => {
  it('answers 503 NOT_STARTED before deps are wired', async () => {
    const routes = buildRoutes()
    setRestDeps(null)
    for (const path of ['/live', '/health', '/snapshots', '/voyages', '/ais/targets', '/map-config']) {
      const r = await call(routes, path)
      expect(r.status, path).toBe(503)
      expect((r.body as { error: { code: string } }).error.code, path).toBe('NOT_STARTED')
    }
  })

  it('rejects non-numeric query params with 400 JSON', async () => {
    const routes = buildRoutes()
    setRestDeps(stubDeps())
    for (const [path, query] of [
      ['/snapshots', { from: 'abc' }],
      ['/voyages', { limit: 'abc' }],
      ['/ais/targets', { max_nm: 'x' }],
      ['/rollups/hourly', { to: '12,5' }]
    ] as const) {
      const r = await call(routes, path, { query: query as Record<string, unknown> })
      expect(r.status, path).toBe(400)
      expect((r.body as { error: { code: string } }).error.code, path).toBe('BAD_PARAM')
    }
  })

  it('clamps the voyages limit into 1..500 and defaults to 50', async () => {
    const routes = buildRoutes()
    const seen: number[] = []
    setRestDeps(
      stubDeps({
        voyages: async (limit: number) => {
          seen.push(limit)
          return []
        }
      })
    )
    await call(routes, '/voyages', { query: { limit: '9999' } })
    await call(routes, '/voyages', { query: { limit: '0' } })
    await call(routes, '/voyages')
    expect(seen).toEqual([500, 1, 50])
  })

  it('passes snapshot params through and defaults order to desc', async () => {
    const routes = buildRoutes()
    const seen: unknown[] = []
    setRestDeps(
      stubDeps({
        snapshots: async (q) => {
          seen.push(q)
          return { rows: [] }
        }
      })
    )
    await call(routes, '/snapshots', { query: { from: '100', to: '200', bucket: '60', order: 'asc' } })
    await call(routes, '/snapshots')
    expect(seen[0]).toMatchObject({ from: 100, to: 200, bucket: 60, order: 'asc' })
    expect(seen[1]).toMatchObject({ bucket: 1, order: 'desc' })
  })

  it('rejects a non-integer voyage id with 400', async () => {
    const routes = buildRoutes()
    setRestDeps(stubDeps())
    const r = await call(routes, '/voyages/:id/track', { params: { id: '1.5' } })
    expect(r.status).toBe(400)
    expect((r.body as { error: { code: string } }).error.code).toBe('BAD_PARAM')
  })

  it('maps QueryError to 400 with its code and other throws to 500', async () => {
    const routes = buildRoutes()
    setRestDeps(
      stubDeps({
        voyageStats: async () => {
          throw new QueryError('BAD_RANGE', 'range too wide')
        },
        voyageCurrent: async () => {
          throw new Error('disk exploded')
        }
      })
    )
    const bad = await call(routes, '/voyages/stats')
    expect(bad.status).toBe(400)
    expect((bad.body as { error: { code: string } }).error.code).toBe('BAD_RANGE')

    const boom = await call(routes, '/voyages/current')
    expect(boom.status).toBe(500)
    const body = boom.body as { error: { code: string; message: string } }
    expect(body.error.code).toBe('INTERNAL')
    // Must not leak the raw error (an fs error would carry the abs data path).
    expect(body.error.message).toBe('internal error')
    expect(body.error.message).not.toContain('disk exploded')
  })
})
