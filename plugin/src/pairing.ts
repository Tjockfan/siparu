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
  | { state: 'paired'; boatId: string; email: string | null; pairedAt: string }
  | { state: 'expired' }
  | { state: 'error'; message: string }

interface Deps {
  app: ServerAPI
  relayUrl: string
  boatName: () => string
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

async function relay<T>(url: string, path: string, body: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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
    throw new Error(`relay ${path} -> ${res.status} ${text.slice(0, 120)}`)
  }
  return (await res.json()) as T
}

/** o***@gmail.com - enough for the owner to recognise themselves, not enough to harvest. */
export function maskEmail(email: string | null): string | null {
  if (!email) return null
  const at = email.indexOf('@')
  if (at < 1) return null
  return `${email[0]}***${email.slice(at)}`
}

export function registerPairRoutes(router: IRouter, deps: Deps): void {
  const { app, relayUrl, boatName, getRemote, saveRemote } = deps

  /** What the on-board screen renders. Safe to poll; never returns a secret. */
  router.get('/pair/status', (_req, res) => {
    void (async () => {
      const remote = getRemote()
      if (remote) {
        res.json({
          state: 'paired',
          boatId: remote.boatId,
          email: remote.pairedEmail,
          pairedAt: remote.pairedAt
        } satisfies PairScreen)
        return
      }

      if (lastError) {
        res.json({ state: 'error', message: lastError } satisfies PairScreen)
        return
      }

      if (!deviceCode || !userCode || !expiresAt) {
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

  /** "Turn on remote viewing" - asks the relay for a code to put on the screen. */
  router.post('/pair/start', (_req, res) => {
    void (async () => {
      if (getRemote()) {
        res.status(409).json({ error: 'already_paired' })
        return
      }
      lastError = null
      try {
        const started = await relay<{
          device_code: string
          user_code: string
          expires_in: number
        }>(relayUrl, '/pair/start', { boat_name: boatName() || null })

        deviceCode = started.device_code
        userCode = started.user_code
        expiresAt = new Date(Date.now() + started.expires_in * 1000).toISOString()

        res.json({ state: 'showing_code', userCode, expiresAt } satisfies PairScreen)
      } catch (e) {
        // No code is generated at all if the relay cannot be reached - the plan is
        // explicit about this. A code the owner can type but the boat can never
        // confirm is worse than an honest error.
        lastError = 'Cannot reach Siparu. Check the boat is online (DNS, port 443, captive portal).'
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
        const done = await relay<{
          boat_id: string
          boat_token: string
          claimed_by_email: string | null
        }>(relayUrl, '/pair/approve', { device_code: deviceCode })

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

        deviceCode = userCode = expiresAt = null
        res.json({ state: 'paired', boatId: done.boat_id } satisfies Partial<PairScreen>)
      } catch (e) {
        app.error(`pair approve failed: ${String(e)}`)
        res.status(502).json({
          state: 'error',
          message: 'Could not finish pairing. Try again.'
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
      res.json({ state: 'idle' } satisfies PairScreen)
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
