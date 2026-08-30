/**
 * The window a statistic is computed over, and how one comes back as a row.
 *
 * The boat summarises every closed hour: for each linear reading a minimum, a maximum, a mean
 * and the number of samples behind it, plus the distance run and the first and last fix. That
 * summary is what makes a season's worth of history answerable at all - and until this module
 * existed, none of it left the boat: `/snapshots` hands back one value per bucket, the last
 * one, so an owner exporting three months got 2,160 instantaneous readings rather than 2,160
 * summaries of an hour each.
 *
 * Wider windows are merged here rather than asked for, because the boat only materialises
 * hours and days: a six-hour window is six hours added up, and the addition is the plugin's
 * own (`plugin/src/aggregate.ts`), not a second implementation ashore. The one thing a merge
 * must not do is average two averages - see mergeAggs.
 */
import { mergeHours, type WindowAgg } from "../../../plugin/src/aggregate";
import { METRIC_KIND, type MetricField, type RollupHour, type Snapshot } from "../../../plugin/src/contract";
import { dayKey } from "../../../plugin/src/time";

/** The windows a summary can be asked for. A minute has no summary: it IS the sample. */
export type BucketGran = "1h" | "6h" | "1d";

/**
 * Which figure of a bucket a column prints.
 *
 * "Last" is what the product shipped with and stays the default: the reading the boat held
 * when the hour closed, which is what a logbook page has always meant. The rest are the
 * summary, and they are the reason somebody exports a season.
 */
export type Stat = "last" | "avg" | "min" | "max";

/**
 * What a figure is called where a person reads it: the chips in the export panel, and the
 * masthead of a page that carries it. Named once, because a page of means that does not say
 * so reads as a page of readings - and the panel and the page must not be able to disagree
 * about which figure that was. STAT_NAME below is the file's short form and stays a file's.
 */
export const STAT_LABEL: Record<Stat, string> = {
  last: "Last",
  avg: "Average",
  min: "Minimum",
  max: "Maximum",
};

export const STAT_NAME: Record<Stat, string> = {
  last: "last",
  avg: "avg",
  min: "min",
  max: "max",
};

export interface Bucket extends WindowAgg {
  /** The UTC window this covers, as the boat names it: "2026-08-27T14" or "2026-08-27". */
  key: string;
}

/** Which window a closed hour belongs to. */
function windowKey(h: RollupHour, gran: BucketGran): string {
  if (gran === "1h") return h.hour;
  if (gran === "1d") return dayKey(h.last_ts);
  // Six-hourly, split on the same boundaries the plugin uses for bucket=360 so a window
  // exported here and one drawn on the screen cover the same six hours.
  const win = Math.floor(h.last_ts / (6 * 3_600_000));
  return `${dayKey(h.last_ts)}#${win % 4}`;
}

/**
 * Closed hours grouped into the windows the reader asked for, oldest first.
 *
 * Order is the file's, not the screen's: a spreadsheet is read downwards and a season reads
 * forwards.
 */
export function bucketHours(hours: readonly RollupHour[], gran: BucketGran): Bucket[] {
  const groups = new Map<string, RollupHour[]>();
  for (const h of hours) {
    const key = windowKey(h, gran);
    const g = groups.get(key);
    if (g) g.push(h);
    else groups.set(key, [h]);
  }
  return [...groups.entries()]
    .map(([key, hs]) => ({ key, ...mergeHours(hs) }))
    .sort((a, b) => a.last_ts - b.last_ts);
}

/**
 * One bucket as a snapshot-shaped row, reading the named figure from every metric.
 *
 * Angular and text readings carry nothing but their last value - there is no mean of a heading
 * and none of "motoring" - so they come back null for every other figure. That is not a hole
 * to be apologised for: it is what lets the caller work out which columns a figure can be
 * printed in, by asking the same question the screen asks (does any row have something to put
 * here?) rather than by keeping a hand-written list of which metrics average. METRIC_KIND is
 * the one declaration of that, and this reads it.
 */
export function bucketRow(b: Bucket, stat: Stat): Snapshot {
  const row = { ts: b.last_ts, lat: b.pos_last?.lat ?? null, lon: b.pos_last?.lon ?? null } as Snapshot;
  const cell = (v: number | string | null | undefined) => (v === undefined ? null : v);
  for (const [name, kind] of Object.entries(METRIC_KIND)) {
    if (kind === "position") continue;
    const field = name as MetricField;
    const agg = b.metrics[field];
    const value =
      kind === "linear" ? cell(agg?.[stat]) : stat === "last" ? cell(agg?.last) : null;
    (row as unknown as Record<string, unknown>)[field] = value;
  }
  const gauges: Record<string, number> = {};
  for (const [path, agg] of Object.entries(b.path_metrics ?? {})) {
    const v = agg[stat];
    if (typeof v === "number") gauges[path] = v;
  }
  if (Object.keys(gauges).length > 0) row.path_values = gauges;
  return row;
}
