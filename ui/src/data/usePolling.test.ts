/**
 * A slow poller tries a refused read again soon, rather than waiting out its interval.
 *
 * The polling runs apart from React (startPolling), so it is clocked here with fake timers
 * and a document stub: the poller reads document.hidden and listens for visibility changes,
 * and that is all of the page it touches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startPolling, type PollSink } from "./usePolling";

let hidden = false;

beforeEach(() => {
  hidden = false;
  (globalThis as { document?: unknown }).document = {
    get hidden() {
      return hidden;
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { document?: unknown }).document;
});

function sink<T>() {
  const values: T[] = [];
  const errors: Error[] = [];
  const s: PollSink<T> = { value: (v) => values.push(v), error: (e) => errors.push(e), settled: () => undefined };
  return { s, values, errors };
}

describe("startPolling", () => {
  it("tries a refused read again after five seconds when the interval is longer", async () => {
    let calls = 0;
    const fetcher = () => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error("not yet")) : Promise.resolve(calls);
    };
    const { s, values, errors } = sink<number>();
    const stop = startPolling(fetcher, 60_000, s);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    expect(errors).toHaveLength(1);
    // Four seconds on: nothing yet. The retry is not immediate, and not the interval either.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(calls).toBe(2);
    expect(values).toEqual([2]);
    // The retry is one-off: the next read is the interval's own, a minute in.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(calls).toBe(3);
    stop();
  });

  it("does not add a retry to a poller already faster than the retry", async () => {
    let calls = 0;
    const fetcher = () => {
      calls += 1;
      return Promise.reject(new Error("never"));
    };
    const { s } = sink<number>();
    const stop = startPolling(fetcher, 2_000, s);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(2_100);
    // One interval tick, and no extra attempt squeezed in before it.
    expect(calls).toBe(2);
    stop();
  });

  it("does not retry after it has been stopped", async () => {
    let calls = 0;
    const fetcher = () => {
      calls += 1;
      return Promise.reject(new Error("never"));
    };
    const { s } = sink<number>();
    const stop = startPolling(fetcher, 60_000, s);
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(1);
  });
});
