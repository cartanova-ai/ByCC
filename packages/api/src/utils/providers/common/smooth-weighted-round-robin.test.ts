import { describe, expect, it } from "vitest";

import { SmoothWeightedRoundRobin } from "./smooth-weighted-round-robin";

function pickMany(selector: SmoothWeightedRoundRobin, ids: number[], count: number): number[] {
  const eligible = new Set(ids);
  return Array.from({ length: count }, () => selector.select(eligible)!);
}

describe("SmoothWeightedRoundRobin", () => {
  it("uses token-id order as the deterministic tie break for equal weights", () => {
    const selector = new SmoothWeightedRoundRobin();
    selector.setToken(2, 1);
    selector.setToken(1, 1);

    expect(pickMany(selector, [1, 2], 4)).toEqual([1, 2, 1, 2]);
  });

  it("produces a smooth 3:1 distribution", () => {
    const selector = new SmoothWeightedRoundRobin();
    selector.setToken(1, 3);
    selector.setToken(2, 1);

    expect(pickMany(selector, [1, 2], 4)).toEqual([1, 1, 2, 1]);
  });

  it("produces a complete 5:2:1 weighted cycle", () => {
    const selector = new SmoothWeightedRoundRobin();
    selector.setToken(1, 5);
    selector.setToken(2, 2);
    selector.setToken(3, 1);

    const picked = pickMany(selector, [1, 2, 3], 8);
    expect(picked.filter((id) => id === 1)).toHaveLength(5);
    expect(picked.filter((id) => id === 2)).toHaveLength(2);
    expect(picked.filter((id) => id === 3)).toHaveLength(1);
  });

  it("selects only from the current eligible set", () => {
    const selector = new SmoothWeightedRoundRobin();
    selector.setToken(1, 10);
    selector.setToken(2, 1);

    expect(selector.select(new Set([2]))).toBe(2);
    expect(selector.select(new Set([1, 2]))).toBe(1);
  });

  it("resets scores when a weight changes or a token is removed", () => {
    const selector = new SmoothWeightedRoundRobin();
    selector.setToken(1, 3);
    selector.setToken(2, 1);
    selector.select(new Set([1, 2]));

    selector.setToken(1, 1);
    expect(pickMany(selector, [1, 2], 2)).toEqual([1, 2]);

    selector.removeToken(1);
    expect(selector.select(new Set([1, 2]))).toBe(2);
  });

  it("returns null for empty or unregistered candidates", () => {
    const selector = new SmoothWeightedRoundRobin();
    expect(selector.select(new Set())).toBeNull();
    expect(selector.select(new Set([99]))).toBeNull();
  });

  it("rejects weights outside 1 through 100", () => {
    const selector = new SmoothWeightedRoundRobin();
    expect(() => selector.setToken(1, 0)).toThrow(RangeError);
    expect(() => selector.setToken(1, 101)).toThrow(RangeError);
    expect(() => selector.setToken(1, 1.5)).toThrow(RangeError);
  });
});
