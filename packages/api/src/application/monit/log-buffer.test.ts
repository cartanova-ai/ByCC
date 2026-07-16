import { type LogRecord } from "@logtape/logtape";
import { describe, expect, it } from "vitest";

import { MonitLogBuffer } from "./log-buffer";

function record(partial: Partial<LogRecord> & { message?: readonly unknown[] }): LogRecord {
  return {
    category: ["qgrid"],
    level: "info",
    message: ["hello"],
    rawMessage: "hello",
    timestamp: 1_000,
    properties: {},
    ...partial,
  } as LogRecord;
}

describe("MonitLogBuffer", () => {
  it("flattens interleaved template parts and renders non-string values", () => {
    const buffer = new MonitLogBuffer();
    buffer.push(
      record({ message: ["worker ", 3, " ready in ", { ms: 120 }, ""], timestamp: 42 }),
    );

    const { entries } = buffer.after(undefined, 10);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      seq: 1,
      timestamp: 42,
      level: "info",
      category: ["qgrid"],
      text: 'worker 3 ready in {"ms":120}',
    });
  });

  it("truncates oversized messages and marks the cut", () => {
    const buffer = new MonitLogBuffer(10, 100);
    buffer.push(record({ message: ["x".repeat(500)] }));

    const [entry] = buffer.after(undefined, 1).entries;
    expect(entry!.text).toHaveLength(101);
    expect(entry!.text.endsWith("…")).toBe(true);
  });

  it("evicts oldest entries past capacity while seq stays monotonic", () => {
    const buffer = new MonitLogBuffer(3);
    for (let i = 1; i <= 5; i++) buffer.push(record({ message: [`line ${i}`] }));

    expect(buffer.oldestSeq).toBe(3);
    expect(buffer.latestSeq).toBe(5);
    const { entries } = buffer.after(undefined, 10);
    expect(entries.map((entry) => entry.seq)).toEqual([3, 4, 5]);
    expect(entries.map((entry) => entry.text)).toEqual(["line 3", "line 4", "line 5"]);
  });

  it("returns the tail up to limit when no cursor is given", () => {
    const buffer = new MonitLogBuffer();
    for (let i = 1; i <= 5; i++) buffer.push(record({ message: [`line ${i}`] }));

    const chunk = buffer.after(undefined, 2);
    expect(chunk.entries.map((entry) => entry.seq)).toEqual([4, 5]);
    expect(chunk.nextCursor).toBe(5);
    expect(chunk.dropped).toBe(0);
  });

  it("returns only entries newer than the cursor with no boundary duplicates", () => {
    const buffer = new MonitLogBuffer();
    for (let i = 1; i <= 5; i++) buffer.push(record({ message: [`line ${i}`] }));

    const chunk = buffer.after(2, 10);
    expect(chunk.entries.map((entry) => entry.seq)).toEqual([3, 4, 5]);
    expect(chunk.nextCursor).toBe(5);
    expect(chunk.dropped).toBe(0);
  });

  it("signals dropped lines when the cursor fell behind eviction", () => {
    const buffer = new MonitLogBuffer(3);
    for (let i = 1; i <= 6; i++) buffer.push(record({ message: [`line ${i}`] }));

    // oldest 는 seq 4 — 커서 1 은 seq 2,3 을 유실했다.
    const chunk = buffer.after(1, 10);
    expect(chunk.dropped).toBe(2);
    expect(chunk.entries.map((entry) => entry.seq)).toEqual([4, 5, 6]);
    expect(chunk.nextCursor).toBe(6);
  });

  it("resyncs a future cursor from a previous process to the current tail", () => {
    const buffer = new MonitLogBuffer();
    buffer.push(record({}));

    const chunk = buffer.after(999, 10);
    expect(chunk.entries).toEqual([]);
    expect(chunk.nextCursor).toBe(buffer.latestSeq);
    expect(chunk.dropped).toBe(0);
  });

  it("handles an empty buffer without crashing", () => {
    const buffer = new MonitLogBuffer();
    const chunk = buffer.after(undefined, 10);
    expect(chunk).toEqual({ entries: [], nextCursor: 0, dropped: 0 });
  });

  it("keeps processStartedAt fixed across buffer churn (AE1 server half)", () => {
    const buffer = new MonitLogBuffer(2);
    const startedAt = buffer.processStartedAt;
    for (let i = 0; i < 10; i++) buffer.push(record({}));
    expect(buffer.processStartedAt).toBe(startedAt);
  });

  it("never throws on malformed records", () => {
    const buffer = new MonitLogBuffer();
    expect(() =>
      buffer.push(record({ message: undefined as unknown as readonly unknown[] })),
    ).not.toThrow();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => buffer.push(record({ message: ["cyclic ", cyclic, ""] }))).not.toThrow();
    const { entries } = buffer.after(undefined, 10);
    expect(entries.at(-1)?.text.startsWith("cyclic ")).toBe(true);
  });
});
