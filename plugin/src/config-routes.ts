/**
 * The one route that changes a setting from the webapp: which engine fuel-rate
 * paths feed the per-voyage fuel figure.
 *
 * Note what this does NOT do, exactly like pairing.ts: it does not write to
 * Signal K's data bus. The read-only contract is about the vessel - no deltas,
 * no PUTs, no NMEA out - and this touches none of it. It applies the plugin's
 * own options through the restart function the server hands to start(), the same
 * store the SK admin config screen writes, and the server stops+starts the
 * plugin to apply them (which re-integrates the open voyage from disk under the
 * new selection). savePluginOptions alone would persist to disk but leave the
 * running plugin on the old selection until its next restart. That is why this
 * lives in its own router rather than in rest.ts, which stays GET-only, and why
 * the CI read-only guard names this route as the one webapp write that is not
 * pairing.
 *
 * Authorisation mirrors the server's own posture. On a secured server only a
 * principal the server would let configure it may change this. On an unsecured
 * server - the default, which the plugin warns about at every turn - it is open,
 * the same decision pairing makes: refusing would stop the owner and not a
 * stranger who, on that same server, can already read the token and re-pair the
 * boat. Changing which engine counts is far less than either.
 */
import type { ServerAPI } from '@signalk/server-api'
import type { IRouter, Request, Response } from 'express'
import { securityOff } from './pairing'

interface ConfigDeps {
  app: ServerAPI
  /** The plugin's current raw options, so a save preserves every other setting. */
  getConfig: () => object
  /**
   * What the picker needs in one read: the `propulsion.*.fuel.rate` paths the
   * boat is reporting, and the ones currently counted (empty means all of them).
   */
  fuelPathsView: () => { available: string[]; selected: string[] }
  /**
   * The restart function the server hands to start(): it persists the new
   * options and then stops+starts the plugin so the change takes effect at once.
   * Deliberately not savePluginOptions, which persists without applying: the
   * running plugin would keep the old selection until its next restart, so a
   * picker save would look accepted yet change nothing until the boat restarts.
   */
  restart: (configuration: object) => void
}

/**
 * True when the server would let this request change its configuration - an
 * admin principal on a secured server. Read through the same securityStrategy
 * shape pairing.ts uses (absent from @signalk/server-api's types); the dummy
 * strategy on an unsecured server returns false here, which is why securityOff
 * is checked first rather than leaning on this alone.
 */
function allowConfigure(app: ServerAPI, req: unknown): boolean {
  try {
    const ss = (
      app as unknown as { securityStrategy?: { allowConfigure?: (r: unknown) => boolean } }
    ).securityStrategy
    return ss?.allowConfigure?.(req) === true
  } catch {
    return false
  }
}

/**
 * The JSON body, without an express.json() value import (express is types-only
 * aboard: a value import crashes an AppStore install with no devDependencies).
 * Uses the parsed body when the server already provided one, and reads the
 * stream itself otherwise, so it does not depend on middleware being mounted.
 */
function readJsonBody(req: Request): Promise<unknown> {
  return new Promise((resolve) => {
    const parsed = (req as unknown as { body?: unknown }).body
    if (parsed && typeof parsed === 'object') return resolve(parsed)
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      // A body this small is a config write, never an upload: cap it so a
      // malformed or hostile request cannot grow the string without bound.
      // destroy() stops the stream so `data` cannot keep growing after resolve.
      if (data.length > 64 * 1024) {
        req.destroy()
        resolve(null)
      }
    })
    req.on('end', () => {
      if (!data) return resolve({})
      try {
        resolve(JSON.parse(data))
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

export function registerConfigRoutes(router: IRouter, deps: ConfigDeps): void {
  const { app, getConfig, fuelPathsView, restart } = deps

  // Read side: open like the rest of the dashboard. The picker asks what engines
  // report a fuel rate and which are counted; a write to change it is gated below.
  router.get('/config/fuel-paths', (_req: Request, res: Response) => {
    res.json(fuelPathsView())
  })

  router.post('/config/fuel-paths', (req: Request, res: Response) => {
    if (!securityOff(app, req) && !allowConfigure(app, req)) {
      res.status(403).json({ error: 'admin_required' })
      return
    }
    void (async () => {
      const body = (await readJsonBody(req)) as { paths?: unknown } | null
      const raw = body?.paths
      if (!Array.isArray(raw) || !raw.every((p) => typeof p === 'string')) {
        res.status(400).json({ error: 'paths must be an array of strings' })
        return
      }
      const paths = (raw as string[]).map((p) => p.trim()).filter((p) => p.length > 0)

      // Preserve every other setting: savePluginOptions overwrites the whole
      // object. `remote` is scrubbed defensively - it belongs in the data dir,
      // never in the options the config route serves (see index.ts migration).
      const merged: Record<string, unknown> = { ...(getConfig() as Record<string, unknown>), fuelRatePaths: paths }
      delete merged.remote

      // restart() persists these options (as savePluginOptions would) and then
      // stops+starts the plugin, so the new selection re-integrates the open
      // voyage from disk now. It takes no callback: it returns once the restart
      // is under way, so the response is sent here.
      restart(merged)
      if (!res.headersSent) res.json({ fuelRatePaths: paths })
    })().catch((e: unknown) => {
      app.error(`fuel-paths route failed: ${String(e)}`)
      if (!res.headersSent) res.status(500).json({ error: 'internal' })
    })
  })
}
