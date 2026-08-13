/**
 * Which callers may reach a route that changes something.
 *
 * Signal K serves the plugin on the boat's own network, its default is security off,
 * and it answers every request with `Access-Control-Allow-Origin: *` next to
 * `Access-Control-Allow-Credentials: true`. Those two together mean a page on the open
 * internet, open in any tab on that network, can call these routes AND read the answers.
 * An advert frame is enough. It can unpair her, or read the pairing screen, take the
 * code the helm is displaying and claim her into an account of its own. The owner's
 * screen goes on saying "paired" throughout.
 *
 * A browser tells on itself, which is the whole of the defence here. It stamps every
 * request it makes with where the request came from: `Sec-Fetch-Site` (all three engines
 * since 2020) and, on writes, `Origin` long before that. Both are forbidden header
 * names, so page script cannot set them and cannot dress itself as the helm.
 *
 * Deliberately NOT a login, and three things it does not do:
 *
 *  - A caller with no browser headers is let through. That is curl, a script, Node-RED
 *    on the boat's own network, where `GET /plugins/siparu/config` already hands over
 *    the token in one request. Refusing there would cost the owner their tooling and
 *    cost an intruder nothing.
 *  - DNS rebinding survives it. The browser then believes it is talking to the
 *    attacker's own origin and says `same-origin` truthfully. Closing that needs a
 *    host allow-list, and the boat's address is the owner's to choose.
 *  - The GET reading surface is untouched. It is published in the README as an API for
 *    people to point their own dashboards at, and some of those dashboards are pages on
 *    another port. `/pair/status` is the exception: it carries the pairing code, which
 *    is the one read that leads to a takeover.
 */
import type { Request, Response } from 'express'

type Handler = (req: Request, res: Response) => void

/**
 * True when the browser says this request came from somewhere other than the boat's own
 * screen. False when it says it did, and false when nothing said anything at all.
 */
export function crossSite(headers: Request['headers'] | undefined): boolean {
  const site = header(headers, 'sec-fetch-site')
  if (site) {
    // `none` is the address bar or a bookmark, which is the owner opening the page
    // themselves. `same-site` is a different origin under the same registrable domain,
    // and the dashboard never calls itself that way: it fetches relative paths, so its
    // requests are always same-origin.
    return site !== 'same-origin' && site !== 'none'
  }

  const origin = header(headers, 'origin')
  if (!origin) return false

  // The older browsers, which send Origin on writes and no Sec-Fetch-Site. An origin
  // that will not parse is one a sandboxed frame sent as the literal string "null";
  // it names nobody, so it cannot name this boat.
  let named: string
  try {
    named = new URL(origin).host
  } catch {
    return true
  }
  return named !== header(headers, 'host')
}

/**
 * Wraps a route so a page in a stranger's tab never reaches it. Applied at the point
 * each route is registered rather than as router middleware, so which routes are
 * guarded is readable where the routes are.
 */
export function sameOrigin(handler: Handler): Handler {
  return (req, res) => {
    if (crossSite(req.headers)) {
      res.status(403).json({ error: 'cross_site' })
      return
    }
    handler(req, res)
  }
}

function header(headers: Request['headers'] | undefined, name: string): string | undefined {
  const value = headers?.[name]
  return typeof value === 'string' ? value.toLowerCase() : undefined
}
