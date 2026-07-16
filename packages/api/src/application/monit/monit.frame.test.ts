import { type LogRecord } from "@logtape/logtape";
import { beforeEach, describe, expect, it, vi } from "vitest";

const requestLogSaveMock = vi.hoisted(() => vi.fn());
vi.mock("../request-log/request-log.model", () => ({
  RequestLogModel: { save: requestLogSaveMock, createRun: requestLogSaveMock },
  MICRO_USD: 1_000_000,
}));

import { monitLogBuffer } from "./log-buffer";
import { MonitFrame } from "./monit.frame";

function push(text: string, extra: Partial<LogRecord> = {}): void {
  monitLogBuffer.push({
    category: ["qgrid"],
    level: "info",
    message: [text],
    rawMessage: text,
    timestamp: 1_000,
    properties: {},
    ...extra,
  } as LogRecord);
}

describe("MonitFrame.monitLogs", () => {
  beforeEach(() => {
    requestLogSaveMock.mockReset();
    vi.restoreAllMocks();
  });

  it("returns the tail with a usable nextCursor when no cursor is given", async () => {
    push("first line");
    push("second line");

    const chunk = await MonitFrame.monitLogs();
    expect(chunk.processStartedAt).toBe(monitLogBuffer.processStartedAt);
    expect(chunk.dropped).toBe(0);
    expect(chunk.nextCursor).toBe(monitLogBuffer.latestSeq);
    expect(chunk.entries.at(-1)?.text).toBe("second line");
  });

  it("returns only entries newer than the cursor with no boundary duplicates", async () => {
    const baseline = monitLogBuffer.latestSeq;
    push("after baseline 1");
    push("after baseline 2");

    const chunk = await MonitFrame.monitLogs(baseline);
    expect(chunk.entries.map((entry) => entry.text)).toEqual([
      "after baseline 1",
      "after baseline 2",
    ]);
    expect(chunk.nextCursor).toBe(monitLogBuffer.latestSeq);

    const followUp = await MonitFrame.monitLogs(chunk.nextCursor);
    expect(followUp.entries).toEqual([]);
  });

  it("surfaces dropped counts from the buffer (AE4 server half)", async () => {
    const after = vi.spyOn(monitLogBuffer, "after").mockReturnValue({
      entries: [],
      nextCursor: 10,
      dropped: 3,
    });

    const chunk = await MonitFrame.monitLogs(1);
    expect(after).toHaveBeenCalledWith(1, 1_000);
    expect(chunk.dropped).toBe(3);
  });

  it("handles an empty buffer without crashing", async () => {
    vi.spyOn(monitLogBuffer, "after").mockReturnValue({
      entries: [],
      nextCursor: 0,
      dropped: 0,
    });

    await expect(MonitFrame.monitLogs()).resolves.toMatchObject({
      entries: [],
      nextCursor: 0,
      dropped: 0,
    });
  });

  it("ships only allowlisted DTO fields — the text channel is the live path", async () => {
    // 실제 유출 채널 검증: 템플릿 리터럴 로깅에서 secret 은 보간 값으로 text 에 실린다.
    // properties 는 wire 를 절대 건너지 않는다.
    push("token refresh failed: ", {
      message: ["token refresh failed: ", "sk-interpolated-credential", ""],
      properties: { accessToken: "forbidden-property-secret", refreshToken: "also-forbidden" },
    });

    const chunk = await MonitFrame.monitLogs(monitLogBuffer.latestSeq - 1);
    const serialized = JSON.stringify(chunk);
    expect(serialized).not.toContain("forbidden-property-secret");
    expect(serialized).not.toContain("also-forbidden");
    expect(serialized).not.toContain("properties");
    // text 채널은 보간 값을 그대로 실어 나른다 — 이것이 실제 노출 경로임을 문서화한다.
    expect(chunk.entries.at(-1)?.text).toBe("token refresh failed: sk-interpolated-credential");
    expect(Object.keys(chunk.entries.at(-1)!).toSorted()).toEqual([
      "category",
      "level",
      "seq",
      "text",
      "timestamp",
    ]);
  });

  it("writes no request logs", async () => {
    push("a line");
    await MonitFrame.monitLogs();
    expect(requestLogSaveMock).not.toHaveBeenCalled();
  });
});
