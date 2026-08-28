/**
 * What a season's export is made of.
 *
 * Two things can go wrong here and both are silent. A merge that averages two averages gives a
 * number that looks entirely reasonable and is wrong whenever the hours behind it held
 * different numbers of samples - an hour with a gap in it, which is every hour a boat spends
 * alongside with the instruments waking up. And a figure printed for a metric that has no such
 * figure (the mean of a heading) is worse than a blank: it is a number a reader would act on.
 */
import { describe, expect, it } from "vitest";
import type { RollupHour } from "../../../plugin/src/contract";
import { bucketHours, bucketRow } from "./buckets";

const H = 3_600_000;
const T0 = Date.UTC(2026, 7, 27, 0, 0, 0);

function hour(i: number, over: Partial<RollupHour> = {}): RollupHour {
  const last = T0 + i * H + (H - 1);
  return {
    hour: new Date(T0 + i * H).toISOString().slice(0, 13),
    count: 60,
    first_ts: T0 + i * H,
    last_ts: last,
    distance_nm: 1,
    pos_first: null,
    pos_last: null,
    metrics: { sog: { min: 1, max: 3, avg: 2, n: 60, last: 2.5 } },
    ...over,
  };
}

describe("grouping hours into the window a reader asked for", () => {
  it("leaves hours alone when the window is an hour", () => {
    const out = bucketHours([hour(0), hour(1)], "1h");
    expect(out).toHaveLength(2);
    expect(out[0]?.count).toBe(60);
  });

  it("puts six hours in one six-hourly window and twenty-four in one day", () => {
    const hours = Array.from({ length: 24 }, (_, i) => hour(i));
    expect(bucketHours(hours, "6h")).toHaveLength(4);
    expect(bucketHours(hours, "1d")).toHaveLength(1);
    expect(bucketHours(hours, "1d")[0]?.count).toBe(24 * 60);
  });

  it("returns windows oldest first, whatever order they arrived in", () => {
    const out = bucketHours([hour(3), hour(0), hour(2), hour(1)], "1h");
    expect(out.map((b) => b.last_ts)).toEqual([...out.map((b) => b.last_ts)].sort((a, b) => a - b));
  });

  it("weights the mean by the samples behind each hour", () => {
    // A full hour at 10 and a six-sample hour at 1. The mean of the two means is 5.5 and would
    // pass a casual eye; the mean of the readings is 9.18.
    const full = hour(0, { metrics: { sog: { min: 10, max: 10, avg: 10, n: 60, last: 10 } } });
    const sparse = hour(1, {
      count: 6,
      metrics: { sog: { min: 1, max: 1, avg: 1, n: 6, last: 1 } },
    });
    const [day] = bucketHours([full, sparse], "1d");
    expect(day?.metrics.sog?.avg).toBeCloseTo(606 / 66, 6);
    expect(day?.metrics.sog?.min).toBe(1);
    expect(day?.metrics.sog?.max).toBe(10);
  });

  it("adds up the distance the hours ran", () => {
    const [day] = bucketHours([hour(0), hour(1), hour(2)], "1d");
    expect(day?.distance_nm).toBe(3);
  });
});

describe("a window as a row", () => {
  const [day] = bucketHours(
    [
      hour(0, {
        metrics: {
          sog: { min: 1, max: 3, avg: 2, n: 60, last: 2.5 },
          cog: { last: 1.5 },
          nav_state: { last: "motoring" },
        },
        path_metrics: { "propulsion.port.revolutions": { min: 10, max: 30, avg: 20, n: 60, last: 25 } },
      }),
    ],
    "1d",
  );

  it("reads the figure it was asked for out of a linear metric", () => {
    expect(bucketRow(day!, "avg").sog).toBe(2);
    expect(bucketRow(day!, "min").sog).toBe(1);
    expect(bucketRow(day!, "max").sog).toBe(3);
    expect(bucketRow(day!, "last").sog).toBe(2.5);
  });

  it("leaves a heading and a state blank for every figure but the last", () => {
    expect(bucketRow(day!, "last").cog).toBe(1.5);
    expect(bucketRow(day!, "last").nav_state).toBe("motoring");
    // Not 1.5, and not a rounded 1.5 either: there is no mean of a heading, so the column this
    // row feeds must come back empty and be dropped rather than printed.
    expect(bucketRow(day!, "avg").cog).toBeNull();
    expect(bucketRow(day!, "avg").nav_state).toBeNull();
  });

  it("carries the engine gauges through the same door", () => {
    expect(bucketRow(day!, "avg").path_values?.["propulsion.port.revolutions"]).toBe(20);
    expect(bucketRow(day!, "max").path_values?.["propulsion.port.revolutions"]).toBe(30);
  });

  it("stamps the row at the end of the window it summarises", () => {
    expect(bucketRow(day!, "avg").ts).toBe(day!.last_ts);
  });
});

/**
 * The file itself. What matters here is what a reader opening it in a spreadsheet finds: one
 * column per figure he asked for, no column for a figure that metric cannot carry, and a
 * heading that says which is which only when there is more than one to tell apart.
 */
describe("the summary file", () => {
  const buckets = bucketHours([hour(0), hour(1)], "1h");
  const col = (head: string, read: (s: { sog: number | null }) => string) => ({ head, cell: read });
  const time = col("UTC", () => "");
  const sog = col("SOG", (s) => (s.sog === null ? "" : String(s.sog)));

  it("names a column plainly when the file holds one figure", async () => {
    const { bucketsCsv } = await import("./export");
    const csv = bucketsCsv(buckets, [{ stat: "avg", cols: [time, sog] }]);
    expect(csv.split("\r\n")[0]).toBe("utc,SOG");
  });

  it("says which figure each column is when it holds more than one", async () => {
    const { bucketsCsv } = await import("./export");
    const csv = bucketsCsv(buckets, [
      { stat: "avg", cols: [time, sog] },
      { stat: "max", cols: [time, sog] },
    ]);
    const [head, first] = csv.split("\r\n");
    expect(head).toBe("utc,SOG (avg),SOG (max)");
    // The mean and the peak of the same hour, side by side and different, which is the whole
    // reason this file exists: the old export carried neither.
    expect(first?.split(",").slice(1)).toEqual(["2", "3"]);
  });

  it("adds the window's own numbers when they are asked for", async () => {
    const { bucketsCsv } = await import("./export");
    const csv = bucketsCsv(buckets, [{ stat: "avg", cols: [time, sog] }], {
      distance: true,
      samples: true,
    });
    expect(csv.split("\r\n")[0]).toBe("utc,SOG,distance_nm,samples");
    expect(csv.split("\r\n")[1]?.split(",").slice(2)).toEqual(["1", "60"]);
  });

  it("writes oldest first, whatever order the windows came in", async () => {
    const { bucketsCsv } = await import("./export");
    const csv = bucketsCsv(bucketHours([hour(2), hour(0), hour(1)], "1h"), [
      { stat: "last", cols: [time, sog] },
    ]);
    const stamps = csv.split("\r\n").slice(1, -1).map((l) => l.split(",")[0] ?? "");
    expect(stamps).toEqual([...stamps].sort());
  });
});
