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
  const calls = { subscribes: 0, unsubscribed: 0, errors: [] as string[] }
  const app = {
    calls,
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
