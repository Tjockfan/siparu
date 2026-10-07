/**
 * Where a route's access level is declared.
 *
 * With security switched on, Signal K answers a plugin's routes only to an
 * administrator unless the plugin says otherwise. Since server 2.31 it can:
 * the router handed to registerWithRouter carries access(level), and a route
 * registered through access('readonly') opens to any signed-in user. Before
 * that, an owner who added the admin user this plugin asks for found that the
 * free dashboard aboard now asked every screen for that same admin password,
 * and a read-only account for the crew was turned away at "Sign-in required".
 *
 * Every read route goes through here. Older servers, down to the 2.18 floor,
 * hand over a plain Express router with no access() on it; there the reads
 * fall back to the server's default, admin-only, exactly as they were. The
 * write routes (pairing, the fuel source, the two passage edits) never come
 * through here: they keep the default on every server, and their own guards
 * besides.
 */
import type { IRouter, RequestHandler } from 'express'

/**
 * The one method a read route needs. Nothing that writes is reachable from it,
 * and CI pins that: a verb added here breaks the build. (The server matches
 * permissions by method, so a HEAD to a readable route still falls to the
 * admin default; nothing in the product sends one.)
 */
export interface ReadRegistrar {
  get(path: string, ...handlers: RequestHandler[]): unknown
}

type AccessRouter = IRouter & { access?: (level: 'readonly') => ReadRegistrar | undefined }

export function readable(router: IRouter): ReadRegistrar {
  const access = (router as AccessRouter).access
  if (typeof access === 'function') {
    // Called on the router, not detached: the server's implementation closes over
    // its own state, but a method that reads `this` would otherwise lose it.
    const registrar = access.call(router, 'readonly')
    if (registrar && typeof registrar.get === 'function') return registrar
  }
  return router
}
