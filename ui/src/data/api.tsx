/**
 * What a screen may ask for, and where it asks.
 *
 * The screens in this package draw for two apps that read the same boat from opposite ends of
 * the wire: aboard, the dashboard reads the plugin's REST routes over her own network; ashore,
 * the portal reads the frames she seals and puts questions to her over the relay's socket. The
 * screens do not know which. They read from `useApi()`, and the app that mounts them decides
 * what answers.
 *
 * The shape is the one the on-board REST client always had, kept on purpose: every screen was
 * written against it, and a second shape would have meant a second set of screens. What differs
 * between the two ends is marked optional: pairing, the voyage edits and the fuel-path setting
 * are writes, and the shore speaks a wire protocol that carries reads and nothing else. A screen
 * that finds one of these missing hides the control rather than showing a button that cannot
 * work.
 */
import { createContext, useContext, type ReactNode } from "react";
import type {
  LiveResult,
  MetricField,
  RollupHour,
  RollupsResult,
  Snapshot,
  SnapshotsResult,
  VoyageStatsResult,
} from "../../../plugin/src/contract";

export type { MetricField, RollupHour, RollupsResult, Snapshot, SnapshotsResult, VoyageStatsResult };

/** The live frame, exactly as the plugin's /live returns it. */
export type LiveSnapshot = LiveResult;

/**
 * A read that failed, with the little a screen can act on: an HTTP-shaped status, a sentence,
 * and where the source gave one, its machine-readable reason ("security_off", "BOAT_OFFLINE").
 * The shore's socket has no HTTP status; it reports one in the same family so a screen's
 * "is this the server or the network" branch reads the same on both ends.
 */
export class ApiError extends Error {
  status: number;
  detail: string;
  code?: string;
  constructor(status: number, detail: string, code?: string) {
    super(`${status}: ${detail}`);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
    this.code = code;
  }
}

export type SnapshotsQuery = {
  from?: number;
  to?: number;
  limit?: number;
  offset?: number;
  order?: "asc" | "desc";
  bucket?: number;
};

/** Minute rows over a window, and the instant the boat stops having them. */
export type MinutesResult = { rows: Snapshot[]; minutesFrom: number };

// ===== Barometer =====

export type TimeSeriesPoint = { ts: number; value: number | null };

export type BaroTrend = {
  current_hpa: number | null;
  delta_3h_hpa: number | null;
  gale_flag: boolean;
  series: TimeSeriesPoint[];
};

// ===== Domain types =====

export type Voyage = {
  id: number;
  start_ts: number;
  end_ts: number | null;
  start_lat: number | null;
  start_lon: number | null;
  end_lat: number | null;
  end_lon: number | null;
  distance_nm: number;
  hours_underway: number;
  avg_sog_kn: number | null;
  max_sog_kn: number | null;
  /** Litres burned, integrated from the engines' reported rate; null when no engine reports fuel. */
  fuel_used_l: number | null;
  start_port: string | null;
  end_port: string | null;
  status: "open" | "closed";
};

export type VoyageRollup = {
  distance_nm: number;
  hours_underway: number;
  avg_sog_kn: number | null;
  max_sog_kn: number | null;
};

export type VoyageStatsCards = {
  today: VoyageRollup;
  yesterday: VoyageRollup;
  rolling_7d: VoyageRollup;
  season: VoyageRollup;
};

export type TrackPoint = { ts: number; lat: number; lon: number; sog: number | null };

/** Voyages the owner joined by hand, and so can put back apart. */
export type VoyageEdits = { merged: number[] };

/** What an edit answers with: the voyage that now exists, or why nothing happened. */
export type EditResult = { ok: true; id: number } | { ok: false; error: string };

/** Which engine fuel-rate paths feed the per-voyage fuel figure: the paths the
 *  boat reports, and the subset currently counted (empty means all of them). */
export type FuelPathsView = { available: string[]; selected: string[] };

export type AisTarget = {
  mmsi: string;
  name: string | null;
  lat: number;
  lon: number;
  sog_kn: number | null;
  cog_deg: number | null;
  heading_deg: number | null;
  nav_state: string | null;
  ais_class: string | null;
  ship_type: string | null;
  length_m: number | null;
  distance_nm: number | null;
  ts: number | null;
};

export type AisFeed = {
  targets: AisTarget[];
  own: { lat: number; lon: number } | null;
  count: number;
  error?: string;
};

/**
 * What she did with her last report. `mode` is the verdict: sealed to the screens on her list,
 * or refusing to send at all because there is nobody she can seal to. `reason` is filled in the
 * refusing case and in no other, and it is written for a skipper.
 *
 * An older plugin also answered `clear` here, for a boat that reported unsealed. That boat no
 * longer exists, and the value is read as one more mode this screen has nothing to say about.
 */
export type SealingStatus = {
  devices: number;
  mode: "sealed" | "blocked" | "none";
  reason: string | null;
  /**
   * One fingerprint per screen she seals to, for comparing by eye with what a phone shows.
   * Absent in the earlier plugin, so it is read as a list that may not be there at all.
   */
  screens?: string[];
  /**
   * Whether she holds a root of her own: a first screen witnessed at her helm, against which
   * every later one has to chain. False for a boat paired before that existed, who checks the
   * shape of a key and nothing about who vouched for it.
   */
  screens_pinned?: boolean;
  /** Rows of the shore's answer the chain refused, before sealing began. Pinned boats only. */
  screens_skipped?: { kid: string; reason: string }[];
  /** Screens the last sealed frame could not be wrapped to, though the chain had accepted them. */
  screens_rejected?: { kid: string; reason: string }[];
};

export type HealthResult = {
  status: "ok" | "degraded";
  diagnosis: { code: string; message: string; since_ts: number | null };
  boat_name: string | null;
  last_delta_ts: number | null;
  snapshots_today: number;
  /** Per-path freshness (read by the depth micro-diagnosis). Absent in the earlier plugin. */
  paths?: Record<string, { last_seen_ts: number; active_source: string | null; sources: number }>;
  /** Whether anything is reaching the shore at all. Absent in the earlier plugin. */
  sealing?: SealingStatus;
  /**
   * Whether an AIS receiver has ever been proven aboard. The chart draws its AIS controls
   * from this rather than from the target count: a count of zero is what a boat alone at
   * sea reads, and taking the switch away from her is taking away the one control that
   * answers "is anybody out there". Absent in the earlier plugin.
   */
  ais?: { receiver_seen: boolean; first_seen_ts: number | null };
  /**
   * Whether Signal K is running without security, and whether the plugin is refusing its
   * writes for it. Carried here as well as on the pairing status so a screen ashore, which has
   * no pairing to ask, can show the same notice the helm shows. Absent in the earlier plugin.
   */
  security_off?: boolean;
  pairing_locked?: boolean;
};

export type MapConfig = {
  /** Local Protomaps PMTiles basemap. Null when there is none. */
  basemap: string | null;
  /** Hosted OpenMapTiles TileJSON. Null when a local basemap is present. */
  basemapTiles: string | null;
  seamark: string | null;
  glyphs: string;
  sprite: string;
  local: { basemap: boolean; seamark: boolean; fonts: boolean; sprites: boolean };
};

/**
 * Whether her frames are actually reaching the relay. Paired and streaming are two
 * different things, and the difference is invisible from ashore: the owner would see a
 * screen that stopped updating and no reason why.
 */
export interface UplinkStatus {
  lastSentTs: number | null;
  failures: number;
  /** The relay does not know this token. Only pairing her again fixes it. */
  rejected: boolean;
  /**
   * The relay knows her and will not carry her: remote watching is not running on the
   * account. Optional because a boat on an older build does not send it, and a screen that
   * read `undefined` as `false` would simply be back where it started.
   */
  unentitled?: boolean;
  lastError: string | null;
}

/**
 * Pairing - the boat's half of it. `email` is unmasked in awaiting_approval and masked once
 * paired - deliberately. At the moment of approval the skipper is deciding whether to hand
 * someone their vessel's live position, and "b***@gmail.com" is not enough to make that call.
 * Afterwards it is just a label, so it gets the mask.
 */
export type PairState =
  | { state: "idle" }
  | { state: "showing_code"; userCode: string; expiresAt: string }
  | {
      state: "awaiting_approval";
      userCode: string;
      email: string | null;
      expiresAt: string;
      /**
       * The screen that typed the code, when it offered itself.
       *
       * The one comparison in this product the server cannot take part in: the same four
       * groups appear on the owner's phone, and reading them off both screens is what makes
       * a substituted key visible to a person. Offered, never demanded - approving without
       * looking leaves the boat exactly as safe as she was before any of this existed.
       */
      device?: { kid: string; fingerprint: string };
    }
  | {
      state: "paired";
      boatId: string;
      email: string | null;
      pairedAt: string;
      uplink?: UplinkStatus;
    }
  | { state: "expired" }
  | { state: "error"; message: string };

/**
 * The screen's state, plus the state of the door it stands behind. `security_off` is
 * true when Signal K is running without security, which is its default: the pairing
 * endpoints would then answer anyone on the boat's network. It rides every state
 * because it describes the server, not the flow. `pairing_locked` rides along when
 * that also means the plugin is refusing pairing, unpairing and settings writes -
 * until the owner turns security on, or accepts the open network in the plugin
 * settings. `revoke_pending` is true when an unlink was cut on the boat but the relay
 * has not yet been reached to kill its copy of the key; the plugin keeps retrying on
 * its own.
 */
export type PairScreen = PairState & {
  security_off?: boolean;
  pairing_locked?: boolean;
  revoke_pending?: boolean;
};

/** The reads a screen needs of the boat. Optional groups exist on her own network only. */
export interface ScreenApi {
  live(): Promise<LiveSnapshot>;
  health(): Promise<HealthResult>;
  mapConfig(): Promise<MapConfig>;

  logbook: {
    snapshots(q?: SnapshotsQuery): Promise<Snapshot[]>;
    /**
     * Rows at the resolution the boat recorded them, for a reader who asked for every minute.
     * Everything else on the screens reads `snapshots`, which answers the same windows far
     * more cheaply by taking the hourly summary for any day but today.
     */
    minutes(q?: SnapshotsQuery): Promise<MinutesResult>;
    snapshotLatest(): Promise<LiveSnapshot>;
    /**
     * The boat's own hourly summaries, unflattened: min, max, mean and sample count for every
     * reading, plus the distance run. An export that offers figures reads these.
     */
    rollupHours(from: number, to: number): Promise<RollupHour[]>;
  };

  voyage: {
    list(limit?: number): Promise<Voyage[]>;
    stats(): Promise<VoyageStatsCards>;
    current(): Promise<Voyage | null>;
    track(voyageId: number): Promise<TrackPoint[]>;
    /** Which voyages were made by hand and can be put back the way they were. */
    edits?(): Promise<VoyageEdits>;
    /** The two writes. Aboard only: the wire the shore speaks carries reads and nothing else. */
    mergePrevious?(id: number): Promise<EditResult>;
    undoMerge?(id: number): Promise<EditResult>;
  };

  config: {
    fuelPaths(): Promise<FuelPathsView>;
    /** Aboard only, for the same reason as the voyage edits. */
    setFuelPaths?(paths: string[]): Promise<{ fuelRatePaths: string[] }>;
  };

  tools: {
    baroTrend(hours?: number): Promise<BaroTrend>;
    baroSeries(q: { from: number; to: number; points?: number }): Promise<{ ts: number; hpa: number }[]>;
  };

  /** Her AIS receiver. Absent where the app has no way to read it. */
  ais?: {
    targets(opts?: { maxNm?: number; limit?: number }): Promise<AisFeed>;
  };

  /** Pairing, which happens at her helm and nowhere else. */
  pair?: {
    status(): Promise<PairScreen>;
    start(): Promise<PairScreen>;
    approve(): Promise<PairScreen>;
    deny(): Promise<PairScreen>;
    /** Unlink the boat. The token is destroyed here, on the vessel - no portal needed. */
    reset(): Promise<PairScreen>;
  };
}

const ApiContext = createContext<ScreenApi | null>(null);

/** Every group present, so a screen can fall back to a member of it by name. */
type WholeApi = Required<ScreenApi> & {
  voyage: Required<ScreenApi["voyage"]>;
  config: Required<ScreenApi["config"]>;
};

/**
 * What a screen reads when nothing was provided: every call refuses, naming the omission. A
 * throw at the hook instead would stop a screen rendering at all, and the tests that draw a
 * screen's markup without a boat behind it are the point of drawing without one.
 */
function refusing(): WholeApi {
  const refuse = () => Promise.reject(new Error("no ApiProvider above this screen"));
  return {
    live: refuse,
    health: refuse,
    mapConfig: refuse,
    logbook: { snapshots: refuse, minutes: refuse, snapshotLatest: refuse, rollupHours: refuse },
    voyage: { list: refuse, stats: refuse, current: refuse, track: refuse, edits: refuse, mergePrevious: refuse, undoMerge: refuse },
    config: { fuelPaths: refuse, setFuelPaths: refuse },
    tools: { baroTrend: refuse, baroSeries: refuse },
    ais: { targets: refuse },
    pair: { status: refuse, start: refuse, approve: refuse, deny: refuse, reset: refuse },
  };
}

export const REFUSING: WholeApi = refusing();

export function ApiProvider({ api, children }: { api: ScreenApi; children: ReactNode }) {
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

/** The boat, as the app that mounted this screen reads her. */
export function useApi(): ScreenApi {
  return useContext(ApiContext) ?? REFUSING;
}
