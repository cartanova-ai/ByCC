import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readAnthropicQuotaUsage } from "./anthropic-quota";

const { fetchUsageWithMetaMock } = vi.hoisted(() => ({
  fetchUsageWithMetaMock: vi.fn(),
}));

vi.mock("../../../application/qgrid/oauth", () => ({
  fetchUsageWithMeta: fetchUsageWithMetaMock,
}));

describe("readAnthropicQuotaUsage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T12:00:05.000Z"));
    fetchUsageWithMetaMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses API utilization as 0..100 percent", async () => {
    fetchUsageWithMetaMock.mockResolvedValueOnce({
      data: { five_hour: { utilization: 17, resets_at: null } },
      cachedAt: Date.now() - 1_250,
    });

    await expect(readAnthropicQuotaUsage("access-token")).resolves.toEqual({
      kind: "ok",
      utilizationPct: 17,
      cacheAgeMs: 1_250,
    });
  });

  it("keeps low percent utilization unchanged", async () => {
    fetchUsageWithMetaMock.mockResolvedValueOnce({
      data: { five_hour: { utilization: 1, resets_at: null } },
      cachedAt: Date.now() - 500,
    });

    await expect(readAnthropicQuotaUsage("access-token")).resolves.toMatchObject({
      kind: "ok",
      utilizationPct: 1,
      cacheAgeMs: 500,
    });
  });

  it("treats utilization 0 as a successful lookup", async () => {
    fetchUsageWithMetaMock.mockResolvedValueOnce({
      data: { five_hour: { utilization: 0, resets_at: null } },
      cachedAt: Date.now(),
    });

    await expect(readAnthropicQuotaUsage("access-token")).resolves.toMatchObject({
      kind: "ok",
      utilizationPct: 0,
    });
  });

  it("converts API errors and rejected fetches into lookup_failed", async () => {
    fetchUsageWithMetaMock.mockResolvedValueOnce({
      data: { error: "rate limit API unavailable" },
      cachedAt: Date.now(),
    });
    await expect(readAnthropicQuotaUsage("access-token")).resolves.toMatchObject({
      kind: "lookup_failed",
      reason: "rate limit API unavailable",
    });

    fetchUsageWithMetaMock.mockRejectedValueOnce(new Error("timeout"));
    await expect(readAnthropicQuotaUsage("access-token")).resolves.toMatchObject({
      kind: "lookup_failed",
      reason: "timeout",
    });
  });

  it("treats missing five_hour utilization as lookup_failed", async () => {
    fetchUsageWithMetaMock.mockResolvedValueOnce({
      data: { five_hour: { utilization: null, resets_at: null } },
      cachedAt: Date.now(),
    });

    await expect(readAnthropicQuotaUsage("access-token")).resolves.toMatchObject({
      kind: "lookup_failed",
    });
  });
});
