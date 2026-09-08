/**
 * The window both the range view and the file are built from, and how it decides there was
 * more than it holds.
 *
 * A screen can say so in the line that gives the count. A file cannot: it leaves the app,
 * outlives the screen that made it, and is read by somebody who never saw the note. Both go
 * through here so they cannot disagree about the same window.
 *
 * Below the read, `clamped` still means two things at once; the shared read (data/reads.ts)
 * resolves that against the boat's floor before it reaches this layer, and its own suite pins
 * that. Here the flag already means what it says: something was left out.
 */
import { describe, expect, it, vi } from "vitest";
import type { MinutesResult, Snapshot } from "../../data/api";
import { minuteWindow, RANGE_LIMIT } from "./useLogbookData";

const rows = (n: number): Snapshot[] =>
  Array.from({ length: n }, (_, i) => ({ ts: 1_000 + i }) as Snapshot);

/** The shared read answering with `count` rows, newest first, having already worked out
 *  whether anything was withheld. */
const read = (count: number, clamped = false) =>
  vi.fn(async (): Promise<MinutesResult> => ({ rows: rows(count), minutesFrom: 0, clamped }));

describe("the minute window", () => {
  it("asks for one row past the ceiling, so the answer itself says whether anything was left", async () => {
    const minutes = read(10);
    await minuteWindow(minutes, 1_000, 2_000);
    expect(minutes).toHaveBeenCalledWith({
      from: 1_000,
      to: 2_000,
      limit: RANGE_LIMIT + 1,
      order: "desc",
    });
  });

  it("hands over the whole window when the boat held less than the file can carry", async () => {
    const { rows: out, truncated } = await minuteWindow(read(12), 1_000, 2_000);
    expect(out).toHaveLength(12);
    expect(truncated).toBe(false);
  });

  it("is whole at exactly the ceiling: the extra row asked for never arrived", async () => {
    const { rows: out, truncated } = await minuteWindow(read(RANGE_LIMIT), 1_000, 2_000);
    expect(out).toHaveLength(RANGE_LIMIT);
    expect(truncated).toBe(false);
  });

  it("cuts to the ceiling and reports it, rather than writing a file that stops without saying so", async () => {
    const { rows: out, truncated } = await minuteWindow(read(RANGE_LIMIT + 1), 1_000, 2_000);
    expect(out).toHaveLength(RANGE_LIMIT);
    expect(truncated).toBe(true);
  });

  it("reports a window narrowed below, which the row count here cannot show", async () => {
    // The boat's ceiling is this ceiling, so asking for one more row than it does not produce
    // one: a cut week comes back as a full page and looks like a week that ended.
    const { rows: out, truncated } = await minuteWindow(read(RANGE_LIMIT, true), 1_000, 2_000);
    expect(out).toHaveLength(RANGE_LIMIT);
    expect(truncated).toBe(true);
  });

  it("keeps the newest end of a window it had to cut, which is the end the fetch asked for", async () => {
    const { rows: out } = await minuteWindow(read(RANGE_LIMIT + 3), 1_000, 2_000);
    expect(out[0]!.ts).toBe(1_000);
    expect(out.at(-1)!.ts).toBe(1_000 + RANGE_LIMIT - 1);
  });
});
