import { describe, expect, it } from "vitest";
import { reconcilePaneOrder } from "./pane-order";

describe("reconcilePaneOrder", () => {
  it("appends new ids in order", () => {
    expect(reconcilePaneOrder([], ["a", "b"])).toEqual(["a", "b"]);
    expect(reconcilePaneOrder(["a", "b"], ["c", "a", "b"])).toEqual(["a", "b", "c"]);
  });

  it("keeps the relative position of existing ids regardless of input order", () => {
    expect(reconcilePaneOrder(["a", "b", "c"], ["c", "b", "a"])).toEqual(["a", "b", "c"]);
  });

  it("drops removed ids", () => {
    expect(reconcilePaneOrder(["a", "b", "c"], ["c", "a", "d"])).toEqual(["a", "c", "d"]);
  });

  it("returns the same array when the order is unchanged", () => {
    const previous = ["a", "b"];
    expect(reconcilePaneOrder(previous, new Set(["b", "a"]))).toBe(previous);
    const empty: string[] = [];
    expect(reconcilePaneOrder(empty, [])).toBe(empty);
  });

  it("ignores duplicate ids", () => {
    expect(reconcilePaneOrder([], ["a", "a", "b"])).toEqual(["a", "b"]);
  });
});
