import { describe, expect, it } from "vitest";
import type { UplinkStatus } from "../../lib/api";
import { uplinkLine } from "./PairBand";

/**
 * The one line on the helm screen that says whether her frames are landing.
 *
 * Three ways for them not to be, and they call for three different acts: go and re-pair her,
 * check the aerial, or pay. The line is the only place the difference is stated, so a wrong
 * one costs somebody a trip to the boat.
 */
const up = (over: Partial<UplinkStatus> = {}): UplinkStatus => ({
  lastSentTs: null,
  failures: 0,
  rejected: false,
  lastError: null,
  ...over,
});

describe("uplinkLine", () => {
  it("says she is sending when she is", () => {
    expect(uplinkLine(up({ lastSentTs: Date.now() - 4_000 }))).toMatch(/^Sending · last frame/);
  });

  it("carries the boat's own sentence when the account is not paying", () => {
    const line = uplinkLine(
      up({ unentitled: true, lastError: "Remote watching is not active on this account." })
    );
    expect(line).toBe("Remote watching is not active on this account.");
    // Not the re-pairing advice, which is what this used to fall through to.
    expect(line).not.toMatch(/pair/i);
  });

  it("still tells an owner to pair her again when the relay disowns the token", () => {
    expect(uplinkLine(up({ rejected: true, lastError: "Siparu no longer recognises this boat." })))
      .toMatch(/no longer recognises/);
  });

  it("reads an older boat, which sends no such field, exactly as it did before", () => {
    // undefined is not false only if somebody wrote it that way. A boat on 0.2.4 answers
    // without the field and has to keep getting the failure line she has always got.
    expect(uplinkLine(up({ failures: 3 }))).toBe("Not reaching Siparu.");
  });
});
