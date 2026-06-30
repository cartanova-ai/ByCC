import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type RateLimitSnapshot } from "../../../codex-protocol/v2/RateLimitSnapshot";
import { readOpenAIQuotaUsage, type OpenAIRateLimitsWithMeta } from "./openai-quota";

function snapshot(overrides: Partial<RateLimitSnapshot> = {}): RateLimitSnapshot {
  return {
    limitId: "codex-primary",
    limitName: "Codex Primary",
    primary: { usedPercent: 17, windowDurationMins: 300, resetsAt: 1_782_912_345 },
    secondary: null,
    credits: null,
    planType: null,
    rateLimitReachedType: null,
    ...overrides,
  };
}

function payload(rateLimits: RateLimitSnapshot): OpenAIRateLimitsWithMeta {
  return { data: { rateLimits, rateLimitsByLimitId: null }, cachedAt: Date.now() - 1_250 };
}

describe("readOpenAIQuotaUsage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T12:00:05.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses primary.usedPercent as 0..100 percent", async () => {
    await expect(readOpenAIQuotaUsage(async () => payload(snapshot()))).resolves.toEqual({
      kind: "ok",
      utilizationPct: 17,
      cacheAgeMs: 1_250,
      windowDurationMins: 300,
      resetsAt: 1_782_912_345,
      limitId: "codex-primary",
    });
  });

  it("keeps low percent utilization unchanged", async () => {
    await expect(
      readOpenAIQuotaUsage(async () =>
        payload(snapshot({ primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: null } })),
      ),
    ).resolves.toMatchObject({
      kind: "ok",
      utilizationPct: 1,
    });
  });

  it("treats utilization 0 as a successful lookup", async () => {
    await expect(
      readOpenAIQuotaUsage(async () =>
        payload(
          snapshot({ primary: { usedPercent: 0, windowDurationMins: null, resetsAt: null } }),
        ),
      ),
    ).resolves.toMatchObject({
      kind: "ok",
      utilizationPct: 0,
    });
  });

  it("converts missing primary data and rejected RPCs into lookup_failed", async () => {
    await expect(
      readOpenAIQuotaUsage(async () => payload(snapshot({ primary: null }))),
    ).resolves.toMatchObject({
      kind: "lookup_failed",
      reason: "primary usedPercent unavailable",
    });

    await expect(
      readOpenAIQuotaUsage(async () => {
        throw new Error("rpc timeout");
      }),
    ).resolves.toMatchObject({
      kind: "lookup_failed",
      reason: "rpc timeout",
    });
  });
});
