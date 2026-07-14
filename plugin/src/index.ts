/**
 * Siparu - Signal K plugin entry.
 *
 * Read-only by contract: this plugin never emits deltas and never issues
 * PUT requests. It subscribes to self paths, records history to
 * NDJSON + materialized rollups, and serves a read-only REST API.
 *
 * One runtime dependency: ws, for the live uplink, and it is one on purpose. It carries no
 * install script and no dependency of its own, and its two native helpers are optional peers -
 * which is what lets the AppStore install this plugin with --ignore-scripts and have it work.
 * Anything with a node-gyp step in it breaks on the boat rather than here; check before adding.
 *
 * Everything else - @signalk/server-api, express - is types only, and stays a devDependency:
 * keep every import from them `import type`, because a value import would crash on a boat the
 * AppStore installed without devDependencies.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Plugin, ServerAPI } from '@signalk/server-api'
import type { IRouter } from 'express'
import { buildAisFeed, clampAisQuery } from './ais'
import { chartsDir, resolveMapConfig } from './charts'
import { CONFIG_SCHEMA, DEFAULTS, INTERNAL, Options, resolveOptions } from './config'
import { HealthResult, LiveResult, SnapshotsQuery } from './contract'
import { MetricsState, SUBSCRIBED_PATHS } from './metrics'
import { QueryService } from './query'
import { registerPairRoutes } from './pairing'
import { registerRoutes, setRestDeps } from './rest'
import { RollupEngine } from './rollup'
import { Store } from './store'
import { dayKey } from './time'
import { LiveUplink } from './live'
import { reportedStatus, Uplink } from './uplink'
import { VoyageLog } from './voyagelog'

const PLUGIN_ID = 'siparu'

function packageVersion(): string {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')
    return String(JSON.parse(raw).version)
  } catch {
    return '0.0.0'
  }
}

export = (app: ServerAPI): Plugin => {
  let opts: Options
  let state: MetricsState | null = null
  let store: Store | null = null
  let rollups: RollupEngine | null = null
  let query: QueryService | null = null
  let voyages: VoyageLog | null = null
  let uplink: Uplink | null = null
  let liveUplink: LiveUplink | null = null
  let timer: NodeJS.Timeout | null = null
  let unsubscribes: Array<() => void> = []
  // Bumped on every start/stop; a stale async init aborts instead of leaking
  // a timer + subscription past stop() (server restarts plugins on every
  // config save, so this race is routine, not exotic).
  let startGen = 0
  let startedAt = 0
  let lastSnapshotTs: number | null = null
  let snapshotsToday = 0
  let countedDay = ''

  /** Seed state from the full model so a restart doesn't begin blind. */
  function primeFromModel(s: MetricsState, now: number): void {
    for (const p of SUBSCRIBED_PATHS) {
      const node = app.getSelfPath(p) as
        | { value?: unknown; timestamp?: string; $source?: string }
        | null
        | undefined
      if (node === null || node === undefined) continue
      const isNode = typeof node === 'object' && 'value' in node
      const value = isNode ? node.value : node
      const ts = isNode && node.timestamp ? Date.parse(node.timestamp) || now : now
      s.ingest(p, value, ts, isNode ? node.$source : undefined)
    }
  }

  async function writeSnapshot(): Promise<void> {
    if (!state || !store) return
    const now = Date.now()
    const snap = state.snapshot(now, true)
    await store.append(snap)
    if (voyages) await voyages.feed(snap)
    lastSnapshotTs = now
    const today = dayKey(now)
    if (today !== countedDay) {
      countedDay = today
      snapshotsToday = 0
    }
    snapshotsToday++
    const age = state.lastDeltaTs === null ? null : Math.round((now - state.lastDeltaTs) / 1000)
    app.setPluginStatus(`Recording - ${snapshotsToday} rows today${age === null ? ', no data yet' : age > 60 ? `, data age ${age}s` : ''}`)
  }

  async function health(): Promise<HealthResult> {
    if (!state || !store || !rollups || !query) throw new Error('not started')
    const now = Date.now()
    const usage = await store.rawUsage()
    const degraded = state.lastDeltaTs === null || now - state.lastDeltaTs > INTERNAL.degradedAfterMs
    return {
      status: degraded ? 'degraded' : 'ok',
      now,
      started_at: startedAt,
      version: packageVersion(),
      boat_name: opts.boatName || (app.getSelfPath('name') as string | undefined) || null,
      last_delta_ts: state.lastDeltaTs,
      last_snapshot_ts: lastSnapshotTs,
      snapshots_today: snapshotsToday,
      diagnosis: state.diagnose(now, app.getSelfPath('electrical') != null),
      paths: state.pathAges(now),
      storage: {
        // Absolute data_dir deliberately omitted - it leaks the OS username
        // and FS layout to any reader (anonymous when SK security is off).
        raw_bytes: usage.bytes,
        cap_bytes: opts.maxStorageMB * 1024 * 1024,
        raw_files: usage.files,
        oldest_raw: usage.oldest
      },
      rollup: await rollups.status(now)
    }
  }

  function live(): LiveResult {
    if (!state) throw new Error('not started')
    const now = Date.now()
    const snap = state.snapshot(now, false)
    return {
      ...snap,
      data_age_s: state.lastDeltaTs === null ? null : Math.round((now - state.lastDeltaTs) / 1000)
    }
  }

  const plugin: Plugin = {
    id: PLUGIN_ID,
    name: 'Siparu',
    description:
      'Kept aboard, proven ashore: records position, wind, depth and voyage history on the boat and serves a read-only dashboard. Never writes to the boat.',
    schema: CONFIG_SCHEMA,

    start(config: object): void {
      const gen = ++startGen
      opts = resolveOptions(config)
      const now = Date.now()
      startedAt = now
      countedDay = dayKey(now)
      snapshotsToday = 0

      const s = new MetricsState(opts)
      state = s
      const st = new Store(app.getDataDirPath(), opts.maxStorageMB * 1024 * 1024, (msg) => app.debug(msg))
      store = st
      const ru = new RollupEngine(st, (msg) => app.debug(msg))
      rollups = ru
      const qs = new QueryService(st, ru)
      query = qs
      const vl = new VoyageLog(st, opts, (msg) => app.debug(msg))
      voyages = vl

      st.onHourClosed = async () => {
        await ru.catchUp(Date.now())
        await st.enforceCap()
      }

      // Self-documenting drop point for offline charts (basemap.pmtiles etc).
      try {
        fs.mkdirSync(chartsDir(app.getDataDirPath()), { recursive: true })
      } catch {
        // charts stay remote-only
      }

      app.setPluginStatus('Starting')
      st.init(now)
        .then(async () => {
          await ru.catchUp(Date.now())
          await st.enforceCap()
          await vl.init(Date.now())
          snapshotsToday = await qs.countToday(Date.now())
          countedDay = dayKey(Date.now())
          if (gen !== startGen) return // stopped while initializing

          primeFromModel(s, Date.now())

          app.subscriptionmanager.subscribe(
            {
              // Cast: server-api brands Context/Path as nominal string types.
              context: 'vessels.self' as never,
              subscribe: SUBSCRIBED_PATHS.map((p) => ({
                path: p as never,
                period: INTERNAL.samplePeriodMs,
                policy: 'fixed' as const
              }))
            },
            unsubscribes,
            (err) => app.error(`subscription error: ${err}`),
            (delta) => {
              const arrived = Date.now()
              for (const update of delta.updates ?? []) {
                if (!('values' in update) || !Array.isArray(update.values)) continue
                for (const pv of update.values) s.ingest(pv.path, pv.value, arrived, update.$source)
              }
            }
          )

          timer = setInterval(() => {
            void writeSnapshot()
          }, opts.snapshotSeconds * 1000)

          setRestDeps({
            live,
            health,
            snapshots: (q: SnapshotsQuery) => qs.snapshots(q, Date.now()),
            voyages: async (limit: number) => vl.list(limit),
            voyageCurrent: async () => vl.current(),
            voyageStats: () => vl.stats(ru, Date.now()),
            voyageTrack: (id: number) => vl.track(id, Date.now()),
            aisTargets: async (maxNm?: number, maxAgeMin?: number, limit?: number) =>
              buildAisFeed(
                app.getPath('vessels'),
                app.selfContext,
                Date.now(),
                clampAisQuery(maxNm, maxAgeMin, limit)
              ),
            rollupHours: async (from: number, to: number) => ({
              rows: await ru.readHourly(from, to)
            }),
            mapConfig: () => resolveMapConfig(app.getDataDirPath(), opts.chartsRemoteUrl, opts.chartsBasemapUrl),
            dataDir: () => app.getDataDirPath()
          })

          // Ashore. Only started once the vessel's own recording is up, because that is
          // the order of the promises: her history is hers whether or not anyone ever
          // pays for the remote half, and it must not wait on a network to begin.
          //
          // Started even when she is not paired - it sends nothing until she is, and it
          // means pairing her mid-passage starts the feed without a restart.
          // The socket, and the minute-by-minute POST behind it. Both are started, and only
          // one of them speaks at a time: the POST path stands down while the socket is up
          // and carries her the moment it is not. It is not a fallback that gets switched on
          // when something notices a failure - it is already running when the failure happens.
          const ws = new LiveUplink({
            relayUrl: opts.relayUrl,
            getRemote: () => opts.remote,
            frame: () => live(),
            debug: (msg) => app.debug(msg)
          })
          liveUplink = ws
          ws.start()

          const up = new Uplink({
            relayUrl: opts.relayUrl,
            getRemote: () => opts.remote,
            frame: () => live(),
            debug: (msg) => app.debug(msg),
            liveHealthy: () => ws.healthy()
          })
          uplink = up
          up.start()

          app.setPluginStatus('Recording - waiting for first snapshot')
        })
        .catch((err) => {
          app.setPluginError(`start failed: ${err}`)
        })
    },

    async stop(): Promise<void> {
      startGen++
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      unsubscribes.forEach((f) => {
        try {
          f()
        } catch {
          // best effort
        }
      })
      unsubscribes = []
      setRestDeps(null)
      uplink?.stop()
      liveUplink?.stop()
      if (voyages) await voyages.flush()
      if (store) await store.flush()
      state = null
      store = null
      rollups = null
      query = null
      voyages = null
      uplink = null
      liveUplink = null
      app.setPluginStatus('Stopped')
    },

    registerWithRouter(router: IRouter): void {
      registerRoutes(router)

      // Pairing keeps its own routes. rest.ts is GET-only on purpose - that is part
      // of how "never writes" is proved - and pairing needs POST. It writes nothing
      // to Signal K either way: it calls the relay outbound and saves the plugin's
      // own options.
      registerPairRoutes(router, {
        app,
        relayUrl: opts?.relayUrl ?? DEFAULTS.relayUrl,
        boatName: () => opts?.boatName || String(app.getSelfPath('name') ?? ''),
        uplinkStatus: () => reportedStatus(liveUplink?.status(), uplink?.status() ?? null),
        // The vessel's MMSI or UUID urn. Typed as a plain string, but the server only
        // assigns it when the boat has one or the other, so at runtime it can be
        // undefined - which is fine, because nothing is authorised by it: it is reported
        // for identification, never used to prove who she is.
        vesselUrn: () => String(app.selfId ?? ''),
        getRemote: () => opts?.remote,
        saveRemote: async (remote) => {
          // savePluginOptions persists through plugin updates (the plan requires
          // that: a token lost on every npm upgrade would be unusable). Writing the
          // live object too, so a restart is not needed to reflect the new state.
          const next = { ...(opts ?? DEFAULTS), remote }
          await new Promise<void>((resolve, reject) => {
            app.savePluginOptions(next, (err?: unknown) =>
              err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve()
            )
          })
          opts = next

          // A new link is not answerable for the old one's failures: an unlink followed
          // by a fresh pairing must not leave "rejected" on the screen of a boat that is
          // now streaming perfectly well.
          uplink?.reset()
          liveUplink?.reset()
        }
      })
    }
  }

  return plugin
}
