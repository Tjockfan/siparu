/**
 * The orphan-token seam: an unlink clicked while the relay is unreachable used
 * to drop the local copy of the token anyway - and the token is the only
 * credential that can revoke itself, so the relay's copy lived forever.
 * These tests pin the whole path: the failed unlink parks the token, the
 * screen admits it, and the retry delivers or resolves it.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { ServerAPI } from '@signalk/server-api'
import type { IRouter } from 'express'
import type { Request, Response } from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { __resetPairingState, registerPairRoutes, RemoteState, retryPendingUnlink } from '../src/pairing'
import { PendingUnlink, RemoteLinkStore } from '../src/remotelink'

type Handler = (req: Request, res: Response) => void

const app = { debug: () => {}, error: () => {} } as unknown as ServerAPI

const PAIRED: RemoteState = {
  boatId: 'boat-1',
  boatToken: 'the-token-she-holds',
  pairedEmail: 's***@example.com',
  pairedAt: '2026-07-01T00:00:00.000Z'
}

function routes(opts: { remote?: RemoteState } = {}) {
  const handlers = new Map<string, Handler>()
  const router = {
    get: (p: string, h: Handler) => handlers.set(`GET ${p}`, h),
    post: (p: string, h: Handler) => handlers.set(p, h)
  } as unknown as IRouter
  let remote = opts.remote
  let pending: PendingUnlink | undefined
  registerPairRoutes(router, {
    app,
    relayUrl: 'https://relay.example',
    boatName: () => 'Test Vessel',
    vesselUrn: () => '',
    uplinkStatus: () => null,
    getRemote: () => remote,
    saveRemote: async (r) => {
      remote = r
    },
    getPendingUnlink: () => pending,
    setPendingUnlink: async (p) => {
      pending = p
    }
  })
  return {
    handlers,
    getRemote: () => remote,
    getPending: () => pending
  }
}

function call(handlers: Map<string, Handler>, route: string): Promise<unknown> {
  return new Promise((resolve) => {
    const res = {
      json: (body: unknown) => resolve(body),
      status: () => res
    } as unknown as Response
    handlers.get(route)!({ body: {} } as Request, res)
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  __resetPairingState()
})

describe('unlink while the relay is unreachable', () => {
  it('cuts the local link, parks the token, and the screen says so', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      })
    )
    const r = routes({ remote: PAIRED })
    const screen = (await call(r.handlers, '/pair/reset')) as { state: string }

    expect(screen.state).toBe('idle')
    expect(r.getRemote()).toBeUndefined()
    expect(r.getPending()?.boatToken).toBe(PAIRED.boatToken)

    const status = (await call(r.handlers, 'GET /pair/status')) as { state: string; revoke_pending?: boolean }
    expect(status.state).toBe('idle')
    expect(status.revoke_pending).toBe(true)
  })

  it('parks nothing when the relay answers 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })))
    const r = routes({ remote: PAIRED })
    await call(r.handlers, '/pair/reset')
    expect(r.getPending()).toBeUndefined()

    const status = (await call(r.handlers, 'GET /pair/status')) as { revoke_pending?: boolean }
    expect(status.revoke_pending).toBeUndefined()
  })

  it('parks nothing when the relay says 401 - that token is already dead there', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'unknown_token' }), { status: 401 }))
    )
    const r = routes({ remote: PAIRED })
    const screen = (await call(r.handlers, '/pair/reset')) as { state: string }
    expect(screen.state).toBe('idle')
    expect(r.getPending()).toBeUndefined()
  })
})

describe('retryPendingUnlink', () => {
  const pendingOf = (token: string): PendingUnlink => ({ boatToken: token, since: '2026-07-18T00:00:00.000Z' })

  it('delivers the unlink and clears the parked token', async () => {
    const sent: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
        sent.push(init.headers.authorization ?? '')
        expect(String(url)).toBe('https://relay.example/pair/unlink')
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      })
    )
    let pending: PendingUnlink | undefined = pendingOf('parked-token')
    await retryPendingUnlink(
      'https://relay.example',
      () => pending,
      async () => {
        pending = undefined
      },
      () => {}
    )
    expect(sent).toEqual(['Bearer parked-token'])
    expect(pending).toBeUndefined()
  })

  it('clears on 401: the relay no longer knows the token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'unknown_token' }), { status: 401 }))
    )
    let pending: PendingUnlink | undefined = pendingOf('parked-token')
    await retryPendingUnlink(
      'https://relay.example',
      () => pending,
      async () => {
        pending = undefined
      },
      () => {}
    )
    expect(pending).toBeUndefined()
  })

  it('keeps the token when the relay is still unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      })
    )
    let pending: PendingUnlink | undefined = pendingOf('parked-token')
    await retryPendingUnlink(
      'https://relay.example',
      () => pending,
      async () => {
        pending = undefined
      },
      () => {}
    )
    expect(pending?.boatToken).toBe('parked-token')
  })

  it('does not touch the network when nothing is parked', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await retryPendingUnlink('https://relay.example', () => undefined, async () => {}, () => {})
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('RemoteLinkStore', () => {
  function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'siparu-remotelink-'))
  }

  it('round-trips the link and the parked unlink through a fresh instance', async () => {
    const dir = tmpDir()
    const a = new RemoteLinkStore(dir)
    a.load()
    await a.saveRemote(PAIRED)
    await a.setPendingUnlink({ boatToken: 'old-token', since: '2026-07-18T00:00:00.000Z' })

    const b = new RemoteLinkStore(dir)
    b.load()
    expect(b.getRemote()).toEqual(PAIRED)
    expect(b.getPendingUnlink()?.boatToken).toBe('old-token')
  })

  it('keeps the file out of group and world hands', async () => {
    const dir = tmpDir()
    const s = new RemoteLinkStore(dir)
    s.load()
    await s.saveRemote(PAIRED)
    const mode = fs.statSync(path.join(dir, 'remote.json')).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('reads a torn or foreign file as empty rather than crashing', () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'remote.json'), '{"remote":{"boatId":')
    const s = new RemoteLinkStore(dir)
    s.load()
    expect(s.getRemote()).toBeUndefined()
  })

  it('drops a half-formed link instead of reporting "paired" off it', () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'remote.json'), JSON.stringify({ remote: { boatToken: 'orphan' } }))
    const s = new RemoteLinkStore(dir)
    s.load()
    expect(s.getRemote()).toBeUndefined()
  })

  it('removes the file when the last secret leaves it', async () => {
    const dir = tmpDir()
    const s = new RemoteLinkStore(dir)
    s.load()
    await s.saveRemote(PAIRED)
    await s.saveRemote(undefined)
    expect(fs.existsSync(path.join(dir, 'remote.json'))).toBe(false)
  })
})
