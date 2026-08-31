/**
 * The month, pinned at its edges rather than in the middle.
 *
 * A test asserting "not due after a week" passes for any arithmetic that happens to be longer
 * than a week. The pair either side of the step is what fails when the interval drifts.
 */
import { describe, expect, it } from "vitest";
import { ACK_DAYS, noticeIsDue, noticeShouldOpen } from "./securityNotice";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_790_000_000_000;

describe("noticeIsDue", () => {
  it("opens for a device that has never acknowledged it", () => {
    // A new browser, cleared site data, a second phone: each is a person who has not read this.
    expect(noticeIsDue(NOW, null)).toBe(true);
  });

  it("holds its tongue for a month and speaks again on the day it is up", () => {
    expect(noticeIsDue(NOW, NOW)).toBe(false);
    expect(noticeIsDue(NOW, NOW - (ACK_DAYS - 1) * DAY)).toBe(false);
    expect(noticeIsDue(NOW, NOW - ACK_DAYS * DAY)).toBe(true);
    expect(noticeIsDue(NOW, NOW - (ACK_DAYS + 1) * DAY)).toBe(true);
  });

  it("counts a month as thirty days", () => {
    expect(ACK_DAYS).toBe(30);
  });

  /**
   * A store that cannot be read is not evidence the warning was. The cost of being wrong in
   * this direction is one dialog; in the other it is an open server nobody was told about.
   */
  it("opens on a value it cannot make sense of", () => {
    expect(noticeIsDue(NOW, NaN)).toBe(true);
    expect(noticeIsDue(NOW, Infinity)).toBe(true);
  });

  /** A time in the future is a clock since corrected, or one device's now written by another. */
  it("does not let a future timestamp buy a month of silence", () => {
    expect(noticeIsDue(NOW, NOW + DAY)).toBe(true);
  });
});

/**
 * The decision the dialog acts on, tested here because it cannot be tested where it is used:
 * the component is rendered to markup, and markup is drawn before any effect runs, so a test
 * asking the component whether it opened would read an empty string whatever the arguments.
 */
describe("noticeShouldOpen", () => {
  const base = { securityOff: true, onHelpPage: false, now: NOW, acknowledgedAt: null };

  it("opens over an open server this device has not been told about", () => {
    expect(noticeShouldOpen(base)).toBe(true);
  });

  it("says nothing about a secured server", () => {
    expect(noticeShouldOpen({ ...base, securityOff: false })).toBe(false);
    // Undefined is the first status still in flight, which is not the same as an answer.
    expect(noticeShouldOpen({ ...base, securityOff: undefined })).toBe(false);
  });

  /** Interrupting the instructions with the complaint is the product talking over its answer. */
  it("does not open over the page that explains the fix", () => {
    expect(noticeShouldOpen({ ...base, onHelpPage: true })).toBe(false);
  });

  it("holds its tongue for a month after it has been read, and speaks again after", () => {
    expect(noticeShouldOpen({ ...base, acknowledgedAt: NOW - DAY })).toBe(false);
    expect(noticeShouldOpen({ ...base, acknowledgedAt: NOW - 31 * DAY })).toBe(true);
  });
});
