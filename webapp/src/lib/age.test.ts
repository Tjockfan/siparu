import { describe, expect, it } from "vitest";
import { ageOf } from "./age";

/**
 * Every assertion here sits on a tier boundary rather than in the middle of a band. A
 * test that asks about 300 seconds passes whether the minute tier ends at 3600 or 3000,
 * and reads green while the screen is wrong. Each boundary is pinned from both sides.
 */
describe("ageOf", () => {
  it("counts seconds up to the minute, and not past it", () => {
    expect(ageOf(0)).toEqual({ value: 0, unit: "s" });
    expect(ageOf(59)).toEqual({ value: 59, unit: "s" });
    expect(ageOf(60)).toEqual({ value: 1, unit: "min" });
  });

  it("counts minutes up to the hour, and not past it", () => {
    expect(ageOf(3599)).toEqual({ value: 59, unit: "min" });
    expect(ageOf(3600)).toEqual({ value: 1, unit: "h" });
  });

  it("counts hours up to the day, and not past it", () => {
    expect(ageOf(86399)).toEqual({ value: 23, unit: "h" });
    expect(ageOf(86400)).toEqual({ value: 1, unit: "d" });
  });

  it("has no ceiling above days, because the plugin never forgets a path", () => {
    expect(ageOf(150 * 86400)).toEqual({ value: 150, unit: "d" });
    expect(ageOf(3611 * 3600)).toEqual({ value: 150, unit: "d" });
  });

  /**
   * The reason the tiers are shared at all. Rounding does not just disagree at the
   * edges, it overstates at the exact second a reader arrives: 90s is where a gauge is
   * first called stale, and 3599s is the last second of an hour.
   */
  it("floors, so a tier never announces itself early", () => {
    expect(ageOf(90)).toEqual({ value: 1, unit: "min" });
    expect(ageOf(119)).toEqual({ value: 1, unit: "min" });
    expect(ageOf(120)).toEqual({ value: 2, unit: "min" });
  });

  it("clamps a clock that has run backwards rather than counting up from it", () => {
    expect(ageOf(-1)).toEqual({ value: 0, unit: "s" });
    expect(ageOf(-100_000)).toEqual({ value: 0, unit: "s" });
  });

  /**
   * Inherited, pinned so it is a decision rather than a surprise: NaN loses every
   * comparison, falls the length of the ladder and lands in days. All three screens did
   * this before they shared a ladder. Fixing it is a slice of its own; this assertion is
   * here so that slice has something to break on purpose.
   */
  it("lets an age that is not a number fall through to days, as all three copies did", () => {
    expect(ageOf(NaN)).toEqual({ value: NaN, unit: "d" });
  });
});

/**
 * The three screens' wording, pinned where they are read, because the whole point of
 * sharing the tiers was to keep three deliberate voices rather than flatten them.
 *
 * These reproduce each caller's one-line formatting. They are not the callers themselves:
 * two of the three live in a .tsx that this framework-free suite does not load, and the
 * value here is the wording contract, which is a string.
 */
const TERSE: Record<string, string> = { s: "s", min: "m", h: "h", d: "d" };
const asMap = (s: number) => {
  const { value, unit } = ageOf(s);
  return `${value}${TERSE[unit]} ago`;
};
const asBand = (s: number) => {
  const { value, unit } = ageOf(s);
  return `${value}${unit === "s" ? "s" : ` ${unit}`} ago`;
};
const asGauge = (s: number) => {
  const { value, unit } = ageOf(s);
  return `${value} ${unit.toUpperCase()} AGO`;
};

describe("the three voices that read the same ladder", () => {
  it("the chart popup stays terse, beside its absolute clock", () => {
    expect(asMap(12)).toBe("12s ago");
    expect(asMap(180)).toBe("3m ago");
    expect(asMap(7200)).toBe("2h ago");
    expect(asMap(172_800)).toBe("2d ago");
  });

  it("the pairing band spells its units, because it lands mid-sentence", () => {
    expect(asBand(12)).toBe("12s ago");
    expect(asBand(180)).toBe("3 min ago");
    expect(asBand(7200)).toBe("2 h ago");
    expect(asBand(172_800)).toBe("2 d ago");
  });

  it("the gauge shouts, and keeps the width its reserve was measured against", () => {
    expect(asGauge(90)).toBe("1 MIN AGO");
    expect(asGauge(3599)).toBe("59 MIN AGO");
    expect(asGauge(3600)).toBe("1 H AGO");
    expect(asGauge(86_400)).toBe("1 D AGO");
    // The widest string this can return, which swiss.css reserves 68px for.
    expect("59 MIN AGO".length).toBe(10);
  });
});

/**
 * What the pairing band used to say, and why it no longer says it.
 *
 * The other two screens are an exact no-op across every second from zero to two hundred
 * days. This one is not, and every difference is it adopting an answer the gauge panel
 * had already worked out and written down for itself alone. Pinned so the change is a
 * record rather than a thing that happened.
 */
describe("the pairing band, which is the one screen this changed", () => {
  it("no longer counts to 89 seconds before finding a minute", () => {
    // Was "60s ago" through "89s ago", then jumped straight to "2 min ago".
    expect(asBand(60)).toBe("1 min ago");
    expect(asBand(89)).toBe("1 min ago");
  });

  it("no longer rounds a stale frame up to the next minute", () => {
    // Was "2 min ago" at 90 seconds.
    expect(asBand(90)).toBe("1 min ago");
  });

  it("no longer announces a sixtieth minute instead of an hour", () => {
    // Was "60 min ago".
    expect(asBand(3599)).toBe("59 min ago");
    expect(asBand(3600)).toBe("1 h ago");
  });

  it("no longer asks the reader to divide a season into hours", () => {
    // Was "3611 h ago", under the word "Sending".
    expect(asBand(3611 * 3600)).toBe("150 d ago");
  });
});
