import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// src/index uses `export =`; esbuild exposes it as the default export.
async function loadFactory() {
  const mod = (await import('../src/index')) as unknown as { default: (app: unknown) => Plugin }
  return mod.default
}

interface Plugin {
  start(config: object, restart?: (c: object) => void): void
  stop(): void | Promise<void>
}

function fakeApp(dataDir: string) {
  const calls = { subscribes: 0, unsubscribed: 0, errors: [] as string[], savedOptions: [] as object[] }
  const app = {
    calls,
    savePluginOptions: (opts: object, cb: (err?: unknown) => void) => {
      calls.savedOptions.push(opts)
      cb()
    },
    getDataDirPath: () => dataDir,
    getSelfPath: () => undefined,
    setPluginStatus: () => undefined,
    setPluginError: (msg: string) => calls.errors.push(msg),
    debug: () => undefined,
    error: (msg: string) => calls.errors.push(msg),
    subscriptionmanager: {
      subscribe: (_cmd: unknown, unsubscribes: Array<() => void>) => {
        calls.subscribes++
        unsubscribes.push(() => {
          calls.unsubscribed++
        })
      }
    }
  }
  return app
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10))
  }
}

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'siparu-plugin-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('plugin lifecycle', () => {
  it('start subscribes once, stop unsubscribes', async () => {
    const createPlugin = await loadFactory()
    const app = fakeApp(dir)
    const plugin = createPlugin(app)
    plugin.start({})
    await waitFor(() => app.calls.subscribes === 1)
    expect(app.calls.subscribes).toBe(1)
    await plugin.stop()
    expect(app.calls.unsubscribed).toBe(1)
    expect(app.calls.errors).toEqual([])
  })

  it('stop during async init leaks no subscription (config-save restart race)', async () => {
    const createPlugin = await loadFactory()
    const app = fakeApp(dir)
    const plugin = createPlugin(app)
    plugin.start({})
    await plugin.stop() // init still pending - must cancel it
    await new Promise((r) => setTimeout(r, 200))
    expect(app.calls.subscribes).toBe(0)
  })

  it('rapid restart ends with exactly one live subscription', async () => {
    const createPlugin = await loadFactory()
    const app = fakeApp(dir)
    const plugin = createPlugin(app)
    plugin.start({})
    await plugin.stop()
    plugin.start({})
    await waitFor(() => app.calls.subscribes === 1)
    await new Promise((r) => setTimeout(r, 200))
    expect(app.calls.subscribes).toBe(1) // stale init #1 must not fire late
    await plugin.stop()
    expect(app.calls.unsubscribed).toBe(1)
  })
})

describe('legacy token migration', () => {
  const LEGACY = {
    boatId: 'boat-legacy',
    boatToken: 'token-from-the-options',
    pairedEmail: 'o***@example.com',
    pairedAt: '2026-07-01T00:00:00.000Z'
  }

  it('moves a token found in the options into the data dir and scrubs the options', async () => {
    const createPlugin = await loadFactory()
    const app = fakeApp(dir)
    const plugin = createPlugin(app)
    plugin.start({ remote: LEGACY })
    await waitFor(() => app.calls.savedOptions.length === 1)

    const file = JSON.parse(await fs.readFile(path.join(dir, 'remote.json'), 'utf8')) as {
      remote?: { boatToken?: string }
    }
    expect(file.remote?.boatToken).toBe(LEGACY.boatToken)

    // The options written back carry no token: GET /plugins/<id>/config stops
    // serving it from the next save on.
    expect('remote' in (app.calls.savedOptions[0] as Record<string, unknown>)).toBe(false)
    await plugin.stop()
  })

  it('lets the data-dir file win when both exist - pairing has written only there since', async () => {
    await fs.writeFile(
      path.join(dir, 'remote.json'),
      JSON.stringify({ remote: { ...LEGACY, boatToken: 'newer-token-in-the-file' } })
    )
    const createPlugin = await loadFactory()
    const app = fakeApp(dir)
    const plugin = createPlugin(app)
    plugin.start({ remote: LEGACY })
    await waitFor(() => app.calls.savedOptions.length === 1)

    const file = JSON.parse(await fs.readFile(path.join(dir, 'remote.json'), 'utf8')) as {
      remote?: { boatToken?: string }
    }
    expect(file.remote?.boatToken).toBe('newer-token-in-the-file')
    expect('remote' in (app.calls.savedOptions[0] as Record<string, unknown>)).toBe(false)
    await plugin.stop()
  })

  it('touches neither file nor options when there is nothing to migrate', async () => {
    const createPlugin = await loadFactory()
    const app = fakeApp(dir)
    const plugin = createPlugin(app)
    plugin.start({})
    await waitFor(() => app.calls.subscribes === 1)
    await new Promise((r) => setTimeout(r, 100))
    expect(app.calls.savedOptions).toHaveLength(0)
    await expect(fs.stat(path.join(dir, 'remote.json'))).rejects.toThrow()
    await plugin.stop()
  })
})
