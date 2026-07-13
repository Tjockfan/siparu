/**
 * The boat's half of pairing.
 *
 * Note what this file does NOT do: it does not write to Signal K. It talks
 * outbound to the relay and it saves its own plugin options. The read-only
 * contract is about the vessel's data bus - no deltas, no PUTs, no NMEA out -
 * and nothing here touches it. That is also why these routes live in their own
 * router rather than in rest.ts, which is deliberately GET-only and stays that way.
 *
 * State machine, from the screen's point of view:
 *
 *   idle ──start──▶ showing code ──(owner claims)──▶ awaiting approval
 *                        │                                   │
 *                        │ (60 min TTL)                      ├─ approve ──▶ paired
 *                        ▼                                   └─ deny ─────▶ idle
 *                      expired
 */
import type { ServerAPI } from '@signalk/server-api'
import type { IRouter } from 'express'
import type { UplinkStatus } from './uplink'

/** Written into the plugin's own options, so it survives a plugin update. */
export interface RemoteState {
  boatId: string
  boatToken: string
  pairedEmail: string | null
  pairedAt: string
}

export type PairScreen =
  | { state: 'idle' }
  | { state: 'showing_code'; userCode: string; expiresAt: string }
  | { state: 'awaiting_approval'; userCode: string; email: string | null; expiresAt: string }
  | {
      state: 'paired'
      boatId: string
      email: string | null
      pairedAt: string
      /**
       * Whether she is actually reaching the relay. "Paired" and "streaming" are not
       * the same thing, and the gap between them is where an owner sits watching a
       * screen that has not moved for two days, believing all is well.
       */
      uplink?: UplinkStatus
    }
  | { state: 'expired' }
  | { state: 'error'; message: string }

interface Deps {
  app: ServerAPI
  relayUrl: string
  boatName: () => string
  /** Null before the plugin has finished starting; the screen simply omits it. */
  uplinkStatus: () => UplinkStatus | null
  /**
   * Signal K's own id for this vessel: 'urn:mrn:imo:mmsi:...' when she has an MMSI, her
   * UUID urn otherwise, and empty when the server was never told either.
   *
   * Reported, and deliberately NOT how she is recognised. An mmsi is public - painted on
   * the hull, broadcast over AIS - so anyone can put it in a Signal K server, which makes
   * it an identity she merely asserts. Recognition runs on the token she already holds
   * (see /pair/start). This travels along so a boat can be identified in support and in
   * the owner's own fleet list, nothing more.
   */
  vesselUrn: () => string
  getRemote: () => RemoteState | undefined
  saveRemote: (r: RemoteState | undefined) => Promise<void>
}

/**
 * The device_code lives in memory only. If Signal K restarts mid-pairing the code
 * is lost and the skipper asks for a new one - which is correct: a secret that
 * outlives the screen showing it is a secret waiting to be found in a config file.
 */
let deviceCode: string | null = null
let userCode: string | null = null
let expiresAt: string | null = null
let lastError: string | null = null

/** A relay that answered and said no. Distinct from one that never answered at all. */
export class RelayRefused extends Error {
  constructor(
    readonly status: number,
    /** The relay's machine-readable reason, when it gave one ("not_your_boat"). */
    readonly code: string | null,
    message: string
  ) {
    super(message)
    this.name = 'RelayRefused'
  }
}

/**
 * `boatToken` is the boat proving she is who she says she is. The relay will only let
 * a re-pairing land on an existing vessel when this is present and valid - an identity
 * she merely asserts (her MMSI) is public information and proves nothing.
 */
async function relay<T>(
  url: string,
  path: string,
  body: unknown,
  boatToken?: string
): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(boatToken ? { authorization: `Bearer ${boatToken}` } : {})
      },
      body: JSON.stringify(body)
    })
  } catch (e) {
    // fetch() throws a bare "TypeError: fetch failed" and buries the actual reason -
    // DNS, TLS, a captive portal, a dead uplink - in .cause. On a boat that reason IS
    // the diagnosis, and a log line that omits it sends the owner looking at the wrong
    // thing. Carry it up.
    const cause = e instanceof Error && e.cause ? `: ${String(e.cause)}` : ''
    throw new Error(`relay ${path} unreachable${cause}`)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    let code: string | null = null
    try {
      code = (JSON.parse(text) as { error?: string }).error ?? null
    } catch {
      // Not every refusal is JSON (a proxy, a captive portal, a 502 from the edge).
    }
    // A refusal is not an outage, and telling them apart is the whole point of the
    // message the skipper reads next. The relay rejecting a request means the boat's
    // uplink WORKS - sending them to look at DNS and captive portals is a wrong
    // diagnosis dressed up as a helpful one.
    throw new RelayRefused(res.status, code, `relay ${path} -> ${res.status} ${text.slice(0, 120)}`)
  }
  return (await res.json()) as T
}

/** The relay refused because the claimant does not own the boat she is already linked to. */
const NOT_YOUR_BOAT = 'That account does not own this boat. She is still linked as before.'

/** o***@gmail.com - enough for the owner to recognise themselves, not enough to harvest. */
export function maskEmail(email: string | null): string | null {
  if (!email) return null
  const at = email.indexOf('@')
  if (at < 1) return null
  return `${email[0]}***${email.slice(at)}`
}

export function registerPairRoutes(router: IRouter, deps: Deps): void {
  const { app, relayUrl, boatName, vesselUrn, getRemote, saveRemote, uplinkStatus } = deps

  const paired = (remote: RemoteState): PairScreen => ({
    state: 'paired',
    boatId: remote.boatId,
    email: remote.pairedEmail,
    pairedAt: remote.pairedAt,
    uplink: uplinkStatus() ?? undefined
  })

  /** What the on-board screen renders. Safe to poll; never returns a secret. */
  router.get('/pair/status', (_req, res) => {
    void (async () => {
      const remote = getRemote()

      // A pairing in progress outranks "paired": an already-linked boat can be
      // re-paired, and during that the screen must show the new code. Reporting her as
      // paired would hide the very thing the skipper is standing there to read.
      if (deviceCode === null || userCode === null || expiresAt === null) {
        if (remote) {
          res.json(paired(remote))
          return
        }

        if (lastError) {
          res.json({ state: 'error', message: lastError } satisfies PairScreen)
          return
        }

        res.json({ state: 'idle' } satisfies PairScreen)
        return
      }

      if (new Date(expiresAt).getTime() <= Date.now()) {
        deviceCode = userCode = expiresAt = null
        res.json({ state: 'expired' } satisfies PairScreen)
        return
      }

      try {
        const poll = await relay<{ status: string; claimed_by_email?: string | null }>(
          relayUrl,
          '/pair/poll',
          { device_code: deviceCode }
        )

        if (poll.status === 'awaiting_boat_approval') {
          res.json({
            state: 'awaiting_approval',
            userCode,
            email: poll.claimed_by_email ?? null,
            expiresAt
          } satisfies PairScreen)
          return
        }

        if (poll.status === 'expired' || poll.status === 'not_found' || poll.status === 'denied') {
          deviceCode = userCode = expiresAt = null
          res.json({ state: 'expired' } satisfies PairScreen)
          return
        }

        res.json({ state: 'showing_code', userCode, expiresAt } satisfies PairScreen)
      } catch (e) {
        // The relay being unreachable is the single most common failure on a boat:
        // no internet, captive portal, DNS. Say so plainly instead of spinning.
        res.json({
          state: 'error',
          message: 'Cannot reach Siparu. Is the boat online?'
        } satisfies PairScreen)
        app.debug(`pair status: ${String(e)}`)
      }
    })()
  })

  /**
   * "Turn on remote viewing", and equally "re-pair her".
   *
   * An already-paired boat may start a new pairing without unlinking first, and she
   * SHOULD: the token she is holding travels with this request, and it is the only
   * thing that lets the relay put the new pairing back on the vessel that already
   * exists. Making her unlink first would throw that proof away, and every reinstall
   * would leave the owner another dead duplicate in her fleet.
   */
  router.post('/pair/start', (_req, res) => {
    void (async () => {
      lastError = null
      try {
        const started = await relay<{
          device_code: string
          user_code: string
          expires_in: number
        }>(
          relayUrl,
          '/pair/start',
          {
            boat_name: boatName() || null,
            vessel_urn: vesselUrn() || null
          },
          getRemote()?.boatToken
        )

        deviceCode = started.device_code
        userCode = started.user_code
        expiresAt = new Date(Date.now() + started.expires_in * 1000).toISOString()

        res.json({ state: 'showing_code', userCode, expiresAt } satisfies PairScreen)
      } catch (e) {
        // No code is generated at all if the relay cannot be reached - the plan is
        // explicit about this. A code the owner can type but the boat can never
        // confirm is worse than an honest error.
        lastError =
          e instanceof RelayRefused && e.status === 429
            ? // The relay counts per IP, not per boat, and a boat on Starlink or marina
              // wifi shares hers with everyone else behind the same CGNAT. Blaming the
              // vessel for a neighbour's attempts would send the skipper hunting a fault
              // that is not there.
              'Too many pairing attempts from this network. Wait an hour and try again.'
            : 'Cannot reach Siparu. Check the boat is online (DNS, port 443, captive portal).'
        app.error(`pair start failed: ${String(e)}`)
        res.status(502).json({ state: 'error', message: lastError } satisfies PairScreen)
      }
    })()
  })

  /**
   * The step that matters: someone standing at the boat's screen says yes. This is
   * what stops the stranger who photographed the code in a marina.
   */
  router.post('/pair/approve', (_req, res) => {
    void (async () => {
      if (!deviceCode) {
        res.status(409).json({ error: 'no_pairing_in_progress' })
        return
      }
      try {
        const previous = getRemote()
        const done = await relay<{
          boat_id: string
          boat_token: string
          claimed_by_email: string | null
        }>(relayUrl, '/pair/approve', { device_code: deviceCode })

        // She is already linked, and this approval points somewhere else. That means the
        // account which typed the code does not own her, so the relay opened a boat of
        // ITS own. Adopting it would aim this vessel's feed at a stranger's account and
        // leave the real owner's boat dark - the hijack, arriving by the back door, in a
        // response the boat asked for. The relay refuses this too; the boat refuses it
        // again, because a plugin that trusts whatever comes back has no defence at all.
        if (previous && done.boat_id !== previous.boatId) {
          deviceCode = userCode = expiresAt = null
          app.error(`pair approve returned a different boat (${done.boat_id}); refusing`)
          res.status(409).json({ state: 'error', message: NOT_YOUR_BOAT } satisfies PairScreen)
          return
        }

        // Persist BEFORE reporting success. If the disk is full (Cerbo issue #46 is
        // real and filed) this throws, and the owner is told pairing failed - rather
        // than being told they are paired while the token quietly evaporates on the
        // next restart.
        await saveRemote({
          boatId: done.boat_id,
          boatToken: done.boat_token,
          pairedEmail: maskEmail(done.claimed_by_email),
          pairedAt: new Date().toISOString()
        })

        // The new token is on disk, so the one it replaces may now be retired. This is
        // the only reason the relay left the old token alive at all: had it killed the
        // old one at approval and the write above failed, the boat would be off the air
        // holding a token she never managed to keep. Best effort - if it does not get
        // through, the previous token simply lives a little longer, which is harmless
        // and self-corrects on the next re-pairing.
        await relay(relayUrl, '/pair/confirm', {}, done.boat_token).catch((e: unknown) => {
          app.debug(`pair confirm failed, old token still live: ${String(e)}`)
        })

        deviceCode = userCode = expiresAt = null
        res.json({ state: 'paired', boatId: done.boat_id } satisfies Partial<PairScreen>)
      } catch (e) {
        app.error(`pair approve failed: ${String(e)}`)

        // The relay refuses a re-pairing claimed by anyone who does not already own her,
        // and that is not a fault to retry - it is an answer. Telling the skipper to try
        // again would have them hammering a code that can never work, while the real
        // cause (they typed it into the wrong account) goes unsaid.
        const denied = e instanceof RelayRefused && e.code === 'not_your_boat'
        if (denied) deviceCode = userCode = expiresAt = null

        res.status(denied ? 409 : 502).json({
          state: 'error',
          message: denied ? NOT_YOUR_BOAT : 'Could not finish pairing. Try again.'
        } satisfies PairScreen)
      }
    })()
  })

  router.post('/pair/deny', (_req, res) => {
    void (async () => {
      if (deviceCode) {
        await relay(relayUrl, '/pair/deny', { device_code: deviceCode }).catch(() => {})
      }
      deviceCode = userCode = expiresAt = null

      // Refusing a re-pairing leaves the boat exactly as she was: still linked, still
      // streaming, on the token she already holds. Only an unlink changes that.
      const remote = getRemote()
      res.json(remote ? paired(remote) : { state: 'idle' })
    })()
  })

  /**
   * "Turn off remote viewing", from the boat.
   *
   * This is the GDPR-critical one, and the plan says so: a boat changes hands, and
   * the previous owner must not keep watching her. Cutting from the vessel's own
   * screen - no portal, no account, just Signal K admin access - is the half of
   * that which the new owner actually controls.
   */
  router.post('/pair/reset', (_req, res) => {
    void (async () => {
      const remote = getRemote()

      // Forgetting the token here is not enough - it would go on working at the relay,
      // and anyone holding a copy (an old disk image, a plotter sold with the boat)
      // could still write to this vessel. Tell the relay to kill it, THEN forget it.
      // Best effort: if the boat is offline the local link is still cut, which is what
      // the person standing at the screen asked for.
      if (remote?.boatToken) {
        await relay(relayUrl, '/pair/unlink', {}, remote.boatToken).catch((e: unknown) => {
          app.error(`unlink could not reach the relay, token still live there: ${String(e)}`)
        })
      }

      await saveRemote(undefined)
      deviceCode = userCode = expiresAt = null
      lastError = null
      res.json({ state: 'idle' } satisfies PairScreen)
    })()
  })
}

/** Test seam: the module-level code is per-process, so tests must be able to clear it. */
export function __resetPairingState(): void {
  deviceCode = userCode = expiresAt = null
  lastError = null
}
