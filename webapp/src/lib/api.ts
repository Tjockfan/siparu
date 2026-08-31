/**
 * Plugin REST client. The webapp is served by the Signal K server itself, so
 * everything is same-origin under /plugins/siparu - no auth headers here;
 * if Signal K security is enabled its session cookie applies automatically.
 *
 * The surface is the one the shared screens read (siparu-ui/data, ScreenApi):
 * this file is the on-board way of answering it, over the plugin's routes. The
 * history splitting - today raw, earlier days from the hourly rollup - is the
 * shared arithmetic (sharedReads), fed the two primitives the plugin serves.
 */
import {
  ApiError,
  sharedReads,
  type AisFeed,
  type EditResult,
  type FuelPathsView,
  type HealthResult,
  type LiveSnapshot,
  type MapConfig,
  type PairScreen,
  type RollupHour,
  type ScreenApi,
  type SnapshotsQuery,
  type SnapshotsResult,
  type TrackPoint,
  type Voyage,
  type VoyageEdits,
  type VoyageStatsCards,
} from "siparu-ui/data";

export { ApiError };
export type {
  AisFeed,
  AisTarget,
  BaroTrend,
  HealthResult,
  LiveSnapshot,
  MetricField,
  PairScreen,
  SealingStatus,
  Snapshot,
  UplinkStatus,
  Voyage,
} from "siparu-ui/data";

const BASE = "/plugins/siparu";

/** SK security 401 - the App listens for this and swaps the whole screen for the AuthGate. */
export const AUTH_REQUIRED_EVENT = "sp:auth-required";

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  // 10s timeout: on flaky boat wi-fi a hung request must not pile up under
  // the poll ticks.
  const r = await fetch(BASE + path, { signal: AbortSignal.timeout(10_000), ...init });
  if (!r.ok) {
    if (r.status === 401) window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
    let detail = r.statusText;
    let code: string | undefined;
    try {
      // Two body shapes reach here: Signal K's own errors nest the message
      // ({error:{message}}), the plugin's routes answer flat ({error, message}) -
      // with error as the machine-readable reason a screen can act on.
      const body = (await r.json()) as {
        error?: string | { message?: string };
        message?: string;
      };
      if (typeof body?.message === "string" && body.message) detail = body.message;
      else if (typeof body?.error === "object" && body.error?.message) detail = body.error.message;
      if (typeof body?.error === "string") code = body.error;
    } catch {
      /* not JSON */
    }
    throw new ApiError(r.status, detail, code);
  }
  return r.json() as Promise<T>;
}

async function fetchSnapshotsResult(q: SnapshotsQuery & { bucket: number }): Promise<SnapshotsResult> {
  const p = new URLSearchParams();
  if (q.from !== undefined) p.set("from", String(q.from));
  if (q.to !== undefined) p.set("to", String(q.to));
  if (q.limit !== undefined) p.set("limit", String(q.limit));
  if (q.offset !== undefined) p.set("offset", String(q.offset));
  if (q.order) p.set("order", q.order);
  p.set("bucket", String(q.bucket));
  return http<SnapshotsResult>(`/snapshots?${p}`);
}

async function fetchRollupHours(from: number, to: number): Promise<RollupHour[]> {
  const res = await http<{ rows: RollupHour[] }>(`/rollups/hourly?from=${from}&to=${to}`);
  return res.rows;
}

const reads = sharedReads({ snapshots: fetchSnapshotsResult, rollupHours: fetchRollupHours });

export const api: ScreenApi = {
  live: () => http<LiveSnapshot>("/live"),
  health: () => http<HealthResult>("/health"),
  mapConfig: () => http<MapConfig>("/map-config"),

  logbook: {
    snapshots: reads.snapshots,
    minutes: reads.minutes,
    snapshotLatest: () => http<LiveSnapshot>("/live"),
    rollupHours: fetchRollupHours,
  },

  voyage: {
    list: (limit = 50) => http<Voyage[]>(`/voyages?limit=${limit}`),
    stats: () => http<VoyageStatsCards>("/voyages/stats"),
    current: () => http<Voyage | null>("/voyages/current"),
    track: (voyageId: number) => http<TrackPoint[]>(`/voyages/${voyageId}/track`),
    /** Which voyages were made by hand and can be put back the way they were. */
    edits: () => http<VoyageEdits>("/voyages/edits"),
    // The two writes, each on one line so the CI read-only guard reads verb and
    // action together. They exist on the boat's own network only: the wire
    // protocol the shore speaks carries reads and nothing else.
    mergePrevious: (id: number) => http<EditResult>(`/voyages/${id}/merge-previous`, { method: 'POST' }),
    undoMerge: (id: number) => http<EditResult>(`/voyages/${id}/undo-merge`, { method: 'POST' }),
  },
  config: {
    fuelPaths: () => http<FuelPathsView>("/config/fuel-paths"),
    // POST kept to one line so the CI read-only guard reads verb and path together, as with pairing.
    setFuelPaths: (paths: string[]) => http<{ fuelRatePaths: string[] }>('/config/fuel-paths', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paths }) }),
  },

  tools: {
    baroTrend: reads.baroTrend,
    baroSeries: reads.baroSeries,
    gustSeries: reads.gustSeries,
  },

  ais: {
    targets: (opts?: { maxNm?: number; limit?: number }) => {
      const maxNm = opts?.maxNm ?? 5;
      const limit = opts?.limit ?? 30;
      return http<AisFeed>(`/ais/targets?max_nm=${maxNm}&limit=${limit}`);
    },
  },

  pair: {
    status: () => http<PairScreen>("/pair/status"),
    start: () => http<PairScreen>('/pair/start', { method: 'POST' }),
    approve: () => http<PairScreen>('/pair/approve', { method: 'POST' }),
    deny: () => http<PairScreen>('/pair/deny', { method: 'POST' }),
    /** Unlink the boat. The token is destroyed here, on the vessel - no portal needed. */
    reset: () => http<PairScreen>('/pair/reset', { method: 'POST' }),
  },
};
