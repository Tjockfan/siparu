/**
 * Read-only REST API, mounted by the server at /plugins/siparu/.
 *
 * GET-only by construction - this file is the only place routes are
 * registered, and it registers nothing but router.get(). "Never writes to
 * the boat" is a sales claim backed by grep.
 */
import * as nodePath from 'node:path'
import type { IRouter, Request, Response } from 'express'
import { chartContentType, chartsDir, safeChartPath } from './charts'
import { ApiError, SnapshotsQuery } from './contract'
import { QueryError } from './query'

/** Everything the routes need; wired in index.ts once start() has run. */
export interface RestDeps {
  live(): unknown
  inventory(): unknown
  health(): Promise<unknown>
  snapshots(q: SnapshotsQuery): Promise<unknown>
  voyages(limit: number): Promise<unknown>
  voyageCurrent(): Promise<unknown>
  voyageStats(): Promise<unknown>
  voyageTrack(id: number): Promise<unknown>
  aisTargets(maxNm?: number, maxAgeMin?: number, limit?: number): Promise<unknown>
  rollupHours(from: number, to: number): Promise<unknown>
  mapConfig(): unknown
  /** Plugin data dir - root of the local charts folder. */
  dataDir(): string
}

let deps: RestDeps | null = null

export function setRestDeps(d: RestDeps | null): void {
  deps = d
}

function sendError(res: Response, status: number, code: string, message: string): void {
  const body: ApiError = { error: { code, message } }
  res.status(status).json(body)
}

/**
 * 500 without leaking internals: raw errors (fs ENOENT/EACCES) often carry the
 * absolute data path. Log the detail server-side, return a generic message.
 */
function sendInternal(res: Response, err: unknown): void {
  console.error('siparu: internal error serving request:', err)
  sendError(res, 500, 'INTERNAL', 'internal error')
}

function intParam(req: Request, name: string): number | undefined {
  const raw = req.query[name]
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n)) throw new QueryError('BAD_PARAM', `${name} must be a number`)
  return n
}

export function registerRoutes(router: IRouter): void {
  router.get('/live', (_req, res) => {
    if (!deps) return sendError(res, 503, 'NOT_STARTED', 'plugin is not started')
    res.json(deps.live())
  })

  router.get('/inventory', (_req, res) => {
    if (!deps) return sendError(res, 503, 'NOT_STARTED', 'plugin is not started')
    res.json(deps.inventory())
  })

  router.get('/snapshots', (req, res) => {
    if (!deps) return sendError(res, 503, 'NOT_STARTED', 'plugin is not started')
    let q: SnapshotsQuery
    try {
      const order = req.query.order === 'asc' ? 'asc' : 'desc'
      q = {
        from: intParam(req, 'from'),
        to: intParam(req, 'to'),
        bucket: (intParam(req, 'bucket') ?? 1) as SnapshotsQuery['bucket'],
        limit: intParam(req, 'limit'),
        offset: intParam(req, 'offset'),
        order
      }
    } catch (err) {
      return sendError(res, 400, (err as QueryError).code ?? 'BAD_PARAM', String((err as Error).message))
    }
    deps
      .snapshots(q)
      .then((result) => res.json(result))
      .catch((err) => {
        if (err instanceof QueryError) return sendError(res, 400, err.code, err.message)
        sendInternal(res, err)
      })
  })

  router.get('/health', (_req, res) => {
    if (!deps) return sendError(res, 503, 'NOT_STARTED', 'plugin is not started')
    deps
      .health()
      .then((h) => res.json(h))
      .catch((err) => sendError(res, 500, 'INTERNAL', String(err)))
  })

  const asyncGet = (path: string, handler: (d: RestDeps, req: Request) => Promise<unknown>) => {
    router.get(path, (req, res) => {
      if (!deps) return sendError(res, 503, 'NOT_STARTED', 'plugin is not started')
      const d = deps
      // Promise.resolve wrapper: a synchronous throw (bad param) must land
      // in .catch as JSON, not escape into Express' HTML error page.
      Promise.resolve()
        .then(() => handler(d, req))
        .then((body) => res.json(body))
        .catch((err) => {
          if (err instanceof QueryError) return sendError(res, 400, err.code, err.message)
          sendInternal(res, err)
        })
    })
  }

  asyncGet('/voyages', (d, req) => {
    const limit = Math.min(Math.max(1, intParam(req, 'limit') ?? 50), 500)
    return d.voyages(limit)
  })
  asyncGet('/voyages/current', (d) => d.voyageCurrent())
  asyncGet('/voyages/stats', (d) => d.voyageStats())
  asyncGet('/voyages/:id/track', (d, req) => {
    const id = Number(req.params.id)
    if (!Number.isInteger(id)) throw new QueryError('BAD_PARAM', 'voyage id must be an integer')
    return d.voyageTrack(id)
  })
  asyncGet('/ais/targets', (d, req) =>
    d.aisTargets(intParam(req, 'max_nm'), intParam(req, 'max_age_min'), intParam(req, 'limit'))
  )
  // Raw hourly rollup lines - the webapp derives history series (baro,
  // gust peaks, coarse tracks) from these instead of scanning raw files.
  asyncGet('/rollups/hourly', (d, req) => {
    const from = intParam(req, 'from') ?? 0
    const to = intParam(req, 'to') ?? Date.now()
    return d.rollupHours(from, to)
  })
  // Resolved chart asset URLs (local charts folder vs remote tile server) -
  // the webapp asks instead of guessing, so offline charts "just work".
  asyncGet('/map-config', async (d) => d.mapConfig())

  // Local chart assets (PMTiles/glyphs/sprites) with HTTP Range support -
  // express sendFile answers 206s, which is how PMTiles clients read.
  router.get('/charts/*', (req, res) => {
    if (!deps) return sendError(res, 503, 'NOT_STARTED', 'plugin is not started')
    // Express 4 puts the `*` remainder under params['0'].
    const rest = (req.params as Record<string, string | undefined>)['0']
    const dir = chartsDir(deps.dataDir())
    const abs = safeChartPath(deps.dataDir(), rest ?? '')
    if (!abs) return sendError(res, 400, 'BAD_PATH', 'invalid chart path')
    const explicitType = chartContentType(abs)
    if (explicitType) res.type(explicitType)
    // root + relative path: dotfile denial must only apply to segments
    // BELOW the charts dir - the data dir itself usually lives under a
    // dot directory (~/.signalk) and an absolute path would 403.
    res.sendFile(nodePath.relative(dir, abs), { root: dir, dotfiles: 'deny', cacheControl: true, maxAge: '1h' }, (err) => {
      if (!err || res.headersSent) return
      const status = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500
      sendError(res, status, status === 404 ? 'NOT_FOUND' : 'INTERNAL', 'chart asset unavailable')
    })
  })
}
