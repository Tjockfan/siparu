import { describe, expect, it } from "vitest";
import { OPEN_ROWS_LIMIT, toggleOpen } from "./openRows";

describe("toggleOpen", () => {
  it("opens a closed row and closes an open one", () => {
    expect(toggleOpen([], 7)).toEqual([7]);
    expect(toggleOpen([7], 7)).toEqual([]);
    expect(toggleOpen([7, 9], 7)).toEqual([9]);
  });

  it("keeps a few open, and lets the oldest go for the newest", () => {
    let open: number[] = [];
    for (const id of [1, 2, 3]) open = toggleOpen(open, id);
    expect(open).toEqual([1, 2, 3]);
    expect(open).toHaveLength(OPEN_ROWS_LIMIT);
    expect(toggleOpen(open, 4)).toEqual([2, 3, 4]);
  });

  it("closing one makes room without disturbing the others' order", () => {
    expect(toggleOpen(toggleOpen([1, 2, 3], 2), 4)).toEqual([1, 3, 4]);
  });
});
