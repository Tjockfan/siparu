/**
 * A relay that never answers.
 *
 * This is the most common failure on a boat and the least dramatic: the marina wifi
 * accepts the connection and then swallows it. Nothing errors, nothing closes. The
 * skipper is standing at the helm watching a spinner, and the plugin already knows the
 * words for this ("Cannot reach Siparu. Is the boat online?") - it just had no way to
 * fire, because the fetch carried no timeout and undici's own is 300 seconds.
 *
 * The worst shape of it is /pair/confirm: the pairing has ALREADY succeeded and the
 * token is written when the reply hangs, so the skipper reads failure and starts over.
 */
import type { IRouter, Request, Response } from 'express'
import type { ServerAPI } from '@signalk/server-api'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { __resetPairingState, registerPairRoutes } from '../src/pairing'

type Handler = (req: Request, res: Response) => void

const app = { debug: () => {}, error: () => {} } as unknown as ServerAPI

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  __resetPairingState()
})

function routes() {
  const handlers = new Map<string, Handler>()
  const router = {
    get: (p: string, h: Handler) => handlers.set(`GET ${p}`, h),
    post: (p: string, h: Handler) => handlers.set(p, h)
  } as unknown as IRouter
  registerPairRoutes(router, {
    app,
    relayUrl: 'https://relay.example',
    boatName: () => 'Test Vessel',
    vesselUrn: () => '',
    uplinkStatus: () => null,
    getRemote: () => undefined,
    saveRemote: async () => undefined,
    getPendingUnlinks: () => [],
    addPendingUnlink: async () => undefined
  })
  return handlers
}

function call(handlers: Map<string, Handler>, path: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const res = {
      json: (body: unknown) => resolve(body as Record<string, unknown>),
      status: () => res
    } as unknown as Response
    handlers.get(path)!({ body: {} } as Request, res)
  })
}

describe('the boat gives up on a silent relay', () => {
  it('carries an abort signal into the call at all', async () => {
    // The whole defect was the absence of this. Pinning presence separately from
    // behaviour, because the behaviour test below leans on the runtime honouring it.
    let seen: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { signal?: AbortSignal }) => {
        seen = init?.signal
        return { ok: true, json: async () => ({ user_code: 'ABCD-EFGH', device_code: 'd', expires_at: new Date(Date.now() + 3600_000).toISOString() }) }
      })
    )
    await call(routes(), '/pair/start')
    expect(seen).toBeInstanceOf(AbortSignal)
    expect(seen?.aborted).toBe(false)
  })

  it('stops its clock once the relay has answered', async () => {
    // A timer left running holds the event loop, and Signal K restarts plugins on every
    // config save: twenty seconds of a stopped plugin still ticking, every pairing poll.
    // The clearTimeout is the whole of the fix, so it needs the whole of a test.
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          user_code: 'ABCD-EFGH',
          device_code: 'd',
          expires_at: new Date(Date.now() + 3600_000).toISOString()
        })
      }))
    )
    await call(routes(), '/pair/start')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('turns a hanging relay into the message the skipper needs, not a spinner', async () => {
    // A black hole: the connection is accepted and then nothing. The only thing that
    // ends this is the clock the caller brought with it - which is reachable from here
    // precisely because it is a plain setTimeout and not the runtime's own.
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
          })
      )
    )

    const answered = call(routes(), '/pair/start')

    // Nineteen seconds in, she is still waiting: the guard must not fire early on a
    // slow-but-alive link, which is most of the Mediterranean.
    await vi.advanceTimersByTimeAsync(19_000)
    let settled = false
    void answered.then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(2_000)
    const body = await answered

    expect(body.state).toBe('error')
    // The diagnosis was already written and unreachable. Now it is reachable.
    expect(String(body.message)).toContain('Cannot reach Siparu')
  })
})
