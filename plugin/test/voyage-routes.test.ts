/**
 * The two voyage-edit routes: authorisation, the id, and the codes an owner reads.
 *
 * These are the only writes on the plugin's REST surface besides pairing and the
 * fuel-path picker, and unlike those they change what the boat says happened. The
 * posture is the server's own - admin on a secured server, and on an unsecured one
 * refused until the owner has accepted the open network in the plugin settings -
 * and these pin it, because the route that quietly stops checking is the one
 * nobody notices.
 */
import { describe, expect, it } from 'vitest'
import type { IRouter } from 'express'
import type { ServerAPI } from '@signalk/server-api'
import { registerVoyageEditRoutes } from '../src/voyage-routes'
import type { EditResult } from '../src/voyagelog'

interface Security {
  authenticationRequired: boolean
  allowConfigure: boolean
}

function fakeApp(sec: Security) {
  const errors: string[] = []
  return {
    errors,
    error: (msg: string) => errors.push(msg),
    debug: () => undefined,
    securityStrategy: {
      getLoginStatus: () => ({ authenticationRequired: sec.authenticationRequired }),
      allowConfigure: () => sec.allowConfigure
    }
  }
}

function fakeRes() {
  return {
    _status: 200,
    _json: undefined as unknown,
    headersSent: false,
    status(code: number) {
      this._status = code
      return this
    },
    json(body: unknown) {
      this._json = body
      this.headersSent = true
      return this
    }
  }
}

type Handler = (req: unknown, res: unknown) => void

/** Register, and keep the handlers by the path they were mounted on. */
function mount(app: ReturnType<typeof fakeApp>, answer: (id: number) => Promise<EditResult>, accept = false) {
  const posts: Record<string, Handler> = {}
  const gets: Record<string, Handler> = {}
  const calls: number[] = []
  const router = {
    get: (p: string, h: Handler) => {
      gets[p] = h
    },
    post: (p: string, h: Handler) => {
      posts[p] = h
    }
  } as unknown as IRouter
  registerVoyageEditRoutes(router, {
    app: app as unknown as ServerAPI,
    acceptOpenNetwork: () => accept,
    edits: () => ({ merged: [4] }),
    mergeWithPrevious: (id) => {
      calls.push(id)
      return answer(id)
    },
    undoMerge: (id) => {
      calls.push(id)
      return answer(id)
    }
  })
  return { posts, gets, calls }
}

const ok = async (id: number): Promise<EditResult> => ({ ok: true, id })

async function call(
  app: ReturnType<typeof fakeApp>,
  id: string,
  answer: (n: number) => Promise<EditResult> = ok,
  path = '/voyages/:id/merge-previous',
  accept = false
) {
  const m = mount(app, answer, accept)
  const res = fakeRes()
  m.posts[path]!({ params: { id } } as unknown, res as unknown)
  await new Promise((r) => setImmediate(r))
  return { res, calls: m.calls }
}

const SECURED_ADMIN: Security = { authenticationRequired: true, allowConfigure: true }
const SECURED_GUEST: Security = { authenticationRequired: true, allowConfigure: false }
const UNSECURED: Security = { authenticationRequired: false, allowConfigure: false }

describe('the voyage-edit routes are authorised like the server itself', () => {
  it('an admin on a secured server may edit', async () => {
    const { res, calls } = await call(fakeApp(SECURED_ADMIN), '7')
    expect(res._status).toBe(200)
    expect(res._json).toEqual({ ok: true, id: 7 })
    expect(calls).toEqual([7])
  })

  it('an unsecured server is refused until the owner has accepted the open network', async () => {
    // The record these routes rewrite is the record the product sells as
    // impartial; "anyone aboard the wifi can merge voyages" is not a default.
    const { res, calls } = await call(fakeApp(UNSECURED), '7')
    expect(res._status).toBe(403)
    expect((res._json as { error?: string }).error).toBe('security_off')
    expect(calls).toEqual([])
  })

  it('an unsecured server the owner has answered for is open', async () => {
    const { res } = await call(fakeApp(UNSECURED), '7', ok, '/voyages/:id/merge-previous', true)
    expect(res._status).toBe(200)
  })

  it('a guest on a secured server is refused, and the log is not touched', async () => {
    const { res, calls } = await call(fakeApp(SECURED_GUEST), '7')
    expect(res._status).toBe(403)
    // The refusal has to come before the work, not after it.
    expect(calls).toEqual([])
  })

  it('guards both routes, not just the first one registered', async () => {
    const { res, calls } = await call(fakeApp(SECURED_GUEST), '7', ok, '/voyages/:id/undo-merge')
    expect(res._status).toBe(403)
    expect(calls).toEqual([])
  })
})

describe('the voyage-edit routes read an id and report what happened', () => {
  it.each([['abc'], ['0'], ['-3'], ['1.5'], ['']])('rejects %j before reaching the log', async (id) => {
    const { res, calls } = await call(fakeApp(SECURED_ADMIN), id)
    expect(res._status).toBe(400)
    expect(calls).toEqual([])
  })

  it.each([
    ['not_found', 404],
    ['no_previous', 409],
    ['voyage_open', 409],
    ['nothing_to_undo', 409]
  ])('answers %s with %i, so the screen can say which', async (error, status) => {
    const { res } = await call(fakeApp(SECURED_ADMIN), '7', async () => ({ ok: false, error }))
    expect(res._status).toBe(status)
    expect(res._json).toEqual({ ok: false, error })
  })

  it('turns a refusal it has no status for into a 400 rather than a success', async () => {
    const { res } = await call(fakeApp(SECURED_ADMIN), '7', async () => ({ ok: false, error: 'something_new' }))
    expect(res._status).toBe(400)
  })

  it('reports a thrown error as a 500 and logs it, rather than leaving the caller hanging', async () => {
    const app = fakeApp(SECURED_ADMIN)
    const { res } = await call(app, '7', async () => {
      throw new Error('disk gone')
    })
    expect(res._status).toBe(500)
    expect(app.errors.join(' ')).toContain('disk gone')
  })

  it('serves the undo list on a GET, which needs no authorisation to read', () => {
    const m = mount(fakeApp(SECURED_GUEST), ok)
    const res = fakeRes()
    m.gets['/voyages/edits']!({} as unknown, res as unknown)
    expect(res._json).toEqual({ merged: [4] })
  })
})
