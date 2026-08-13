/**
 * Editing a voyage by hand, from the boat and only from the boat.
 *
 * The engine decides where a passage begins and ends from thresholds, and it is
 * right most of the time. When it is not - one trip recorded as two because the
 * crew stopped for lunch - the owner is the only one who knows, and until now had
 * no way to say so.
 *
 * WHY THIS IS NOT REACHABLE FROM ASHORE, and why that needed no work. The shore
 * talks to the boat over one socket and one closed set of questions, all of them
 * reads: `history`, `snapshots`, `voyages`, `track`, `phases` (see live.ts, which
 * drops anything else before it is looked at). The relay does not proxy this
 * router; the plugin's REST surface is served by the Signal K server on the boat's
 * own network and by nothing else. So a route here is a boat route by
 * construction, and stays one for exactly as long as nobody adds a write to that
 * wire protocol. Keep it that way: "the shore cannot change anything aboard" is
 * a sentence the product means literally.
 *
 * Nothing here writes to Signal K. It rewrites the plugin's own voyage file, which
 * is the plugin's own record of what it observed, and the read-only contract about
 * the vessel - no deltas, no PUTs, no NMEA out - is untouched. That is why rest.ts
 * stays GET-only and why these two POSTs are named in the CI guard beside pairing
 * and the fuel-path picker.
 *
 * Authorisation mirrors config-routes: on a secured server, a principal the server
 * would let configure it; on an unsecured one, open, the same decision pairing
 * makes, because a stranger on that network can already read the boat's token.
 */
import type { ServerAPI } from '@signalk/server-api'
import type { IRouter, Request, Response } from 'express'
import { securityOff } from './pairing'
import { allowConfigure } from './config-routes'
import { sameOrigin } from './origin-guard'
import type { EditResult } from './voyagelog'

interface VoyageEditDeps {
  app: ServerAPI
  /** Which voyages were made by hand and can be put back. */
  edits: () => { merged: number[] }
  mergeWithPrevious: (id: number, now: number) => Promise<EditResult>
  undoMerge: (id: number, now: number) => Promise<EditResult>
}

/** Why an edit did not happen, in the status a caller can act on. */
const STATUS: Record<string, number> = {
  not_found: 404,
  no_previous: 409,
  voyage_open: 409,
  nothing_to_undo: 409
}

export function registerVoyageEditRoutes(router: IRouter, deps: VoyageEditDeps): void {
  const { app, edits, mergeWithPrevious, undoMerge } = deps

  // Read side, open like the rest of the dashboard: the screen has to know which
  // voyages carry an undo before it can offer one.
  router.get('/voyages/edits', (_req: Request, res: Response) => {
    res.json(edits())
  })

  const edit = (
    name: string,
    run: (id: number, now: number) => Promise<EditResult>
  ): ((req: Request, res: Response) => void) => {
    return (req, res) => {
      if (!securityOff(app, req) && !allowConfigure(app, req)) {
        res.status(403).json({ error: 'admin_required' })
        return
      }
      const id = Number((req.params as { id?: string }).id)
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ error: 'id must be a voyage number' })
        return
      }
      void run(id, Date.now())
        .then((result) => {
          if (result.ok) {
            res.json(result)
            return
          }
          res.status(STATUS[result.error] ?? 400).json(result)
        })
        .catch((e: unknown) => {
          app.error(`${name} route failed: ${String(e)}`)
          if (!res.headersSent) res.status(500).json({ error: 'internal' })
        })
    }
  }

  router.post('/voyages/:id/merge-previous', sameOrigin(edit('merge-previous', mergeWithPrevious)))
  router.post('/voyages/:id/undo-merge', sameOrigin(edit('undo-merge', undoMerge)))
}
