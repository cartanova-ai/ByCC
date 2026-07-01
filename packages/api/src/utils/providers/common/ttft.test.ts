import { describe, expect, it } from "vitest";

import { createTtftTracker } from "./ttft";

describe("createTtftTracker", () => {
  it("records the first delta once relative to the marked start", () => {
    let now = 100;
    const tracker = createTtftTracker(() => now);
    const deltas: string[] = [];
    const onDelta = tracker.wrapDelta((text) => deltas.push(text));

    tracker.markStart();
    now = 135;
    onDelta("a");
    now = 200;
    onDelta("b");

    expect(tracker.value()).toBe(35);
    expect(deltas).toEqual(["a", "b"]);
  });

  it("keeps null when no delta is recorded", () => {
    const tracker = createTtftTracker(() => 100);

    tracker.markStart();

    expect(tracker.value()).toBeNull();
  });

  it("does not treat a delta before start as zero", () => {
    const tracker = createTtftTracker(() => 100);

    tracker.recordFirstDelta();

    expect(tracker.value()).toBeNull();
  });
});
