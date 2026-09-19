/**
 * The ship's clock: the hour at the position a reading was taken.
 *
 * A log row used to be stamped in UTC, which is nobody's watch, and before that in the reader's
 * own zone, which made the same row read differently at two desks. The hour aboard is
 * the one a deck log is kept in, and it depends on the boat alone: the zone comes from the
 * row's own position, so a passage that crosses a zone changes clock where the boat did.
 *
 * Everything that leaves as a file stays in UTC (lib/export.ts). A screen is read by someone
 * keeping a watch; a file outlives the zone it was made in.
 */

/** lat/lon to an IANA zone name. The shape of tz-lookup's one function. */
export type ZoneLookup = (lat: number, lon: number) => string;

interface Fix {
  ts: number;
  lat: number | null;
  lon: number | null;
}

/** One formatter per zone and shape: a page of minutes is 1440 rows, and building an
 *  Intl.DateTimeFormat is the expensive part of printing one. */
const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatter(zone: string, shape: string, opts: Intl.DateTimeFormatOptions) {
  const key = `${shape}|${zone}`;
  let f = formatters.get(key);
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat("en-GB", { ...opts, timeZone: zone });
    } catch {
      // A zone name, or a shape, this runtime does not carry. See `usable`: the row falls back
      // to UTC instead of the page throwing, and the head says UTC, so the fallback is
      // labelled as what it is.
      f = null;
    }
    formatters.set(key, f);
  }
  return f;
}

const CLOCK: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
const OFFSET: Intl.DateTimeFormatOptions = { hour: "2-digit", timeZoneName: "shortOffset" };
const DAY: Intl.DateTimeFormatOptions = {
  weekday: "short",
  day: "2-digit",
  month: "short",
  year: "numeric",
};

/**
 * The zone to print in: the one given when this runtime can print all of it, UTC otherwise.
 *
 * All of it, because the offset is what stands over the hours. `shortOffset` is refused by
 * browsers a few years old, and a runtime that can set the ship's hours but cannot name their
 * offset would print them under a head that says UTC.
 */
const usable = (zone: string | null): string =>
  zone !== null && formatter(zone, "clock", CLOCK) && formatter(zone, "offset", OFFSET) && formatter(zone, "day", DAY)
    ? zone
    : "UTC";

/** "03:59" aboard. UTC when the zone is unknown. */
export function shipClock(ts: number, zone: string | null): string {
  return formatter(usable(zone), "clock", CLOCK)!.format(ts);
}

/** "UTC+3", "UTC+5:30", "UTC-3", and plain "UTC" at zero or when the zone is unknown. The
 *  offset is asked of the moment, not of the zone: it moves when the clocks do. */
export function shipOffset(ts: number, zone: string | null): string {
  // Null when the runtime has no `shortOffset` at all, and then every row is already in UTC.
  const f = formatter(usable(zone), "offset", OFFSET);
  if (!f) return "UTC";
  const name = f.formatToParts(ts).find((p) => p.type === "timeZoneName")?.value ?? "";
  const rest = name.replace(/^(GMT|UTC)/, "");
  return /[1-9]/.test(rest) ? `UTC${rest}` : "UTC";
}

/** "THU · 17 SEPT 2026" - the line a page writes where the day turns aboard. */
export function shipDayLine(ts: number, zone: string | null): string {
  return formatter(usable(zone), "day", DAY)!
    .format(ts)
    .replace(/,\s*/, " · ")
    .toUpperCase();
}

/**
 * The zone of every row on a page, keyed by the row's moment.
 *
 * A row with a fix takes the zone of its own position. A row without one borrows from the
 * nearest row in time that has one: a GPS that dropped out for an hour at the dock has not
 * moved the boat to Greenwich. With no fix on the page, or before the lookup has loaded, every
 * row is null and the page reads in UTC and says so.
 */
export function pageZones(rows: readonly Fix[], lookup: ZoneLookup | null): Map<number, string | null> {
  const out = new Map<number, string | null>();
  // ~11 km cells, the same key the top bar's clock uses: a boat swinging at anchor asks once.
  const cells = new Map<string, string | null>();
  const zoneAt = (lat: number, lon: number): string | null => {
    const key = `${Math.round(lat * 10)},${Math.round(lon * 10)}`;
    let z = cells.get(key);
    if (z === undefined) {
      try {
        z = lookup!(lat, lon);
      } catch {
        z = null;
      }
      cells.set(key, z);
    }
    return z;
  };

  const sorted = [...rows].sort((a, b) => a.ts - b.ts);
  const own = sorted.map((r) =>
    lookup !== null && r.lat !== null && r.lon !== null ? zoneAt(r.lat, r.lon) : null
  );
  const fixed = sorted.flatMap((r, i) => (own[i] !== null ? [{ ts: r.ts, zone: own[i] }] : []));
  let j = 0;
  sorted.forEach((r, i) => {
    if (own[i] !== null || fixed.length === 0) {
      out.set(r.ts, own[i]);
      return;
    }
    // fixed is in time order and so is this walk, so the nearest fix only ever moves forward.
    // A tie goes to the earlier fix: where she was last seen, not where she turns up next.
    while (j + 1 < fixed.length && Math.abs(fixed[j + 1].ts - r.ts) < Math.abs(fixed[j].ts - r.ts)) j++;
    out.set(r.ts, fixed[j].zone);
  });
  return out;
}

/** A page's rows, read on the ship's clock: what the time lane prints and what stands over it. */
export interface ShipTimes {
  /** Over the time lane: the offset every row shares ("UTC+3"), or SHIP when the page holds
   *  more than one and no single figure would be true of all of it. Not LOCAL: over a lane of
   *  hours that word reads as the reader's own zone, which is the one clock this never shows. */
  head: string;
  /** True when the rows do not share one offset: a zone crossed, or the clocks changed. The
   *  dated lines carry the offset then, since the head cannot. */
  mixed: boolean;
  clock(ts: number): string;
  /** "THU · 17 SEPT 2026", the day aboard. */
  day(ts: number): string;
  /** "UTC+3", the offset in force at that row. */
  offset(ts: number): string;
  /** The two together, "THU · 17 SEPT 2026 · UTC+3": what a dated line says, and what decides
   *  where one is written. The offset is part of it, so the line turns when either the day or
   *  the offset does, which is when a deck log writes one. */
  dayLine(ts: number): string;
}

export function shipTimes(rows: readonly Fix[], lookup: ZoneLookup | null): ShipTimes {
  const zones = pageZones(rows, lookup);
  // A moment that is not on the page has no position to read a zone off, and reads in UTC.
  const zone = (ts: number) => zones.get(ts) ?? null;
  const offsets = new Set(rows.map((r) => shipOffset(r.ts, zone(r.ts))));
  const mixed = offsets.size > 1;
  return {
    head: mixed ? "SHIP" : offsets.values().next().value ?? "UTC",
    mixed,
    clock: (ts) => shipClock(ts, zone(ts)),
    day: (ts) => shipDayLine(ts, zone(ts)),
    offset: (ts) => shipOffset(ts, zone(ts)),
    dayLine: (ts) => `${shipDayLine(ts, zone(ts))} · ${shipOffset(ts, zone(ts))}`,
  };
}
