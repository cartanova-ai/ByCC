import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type QuotaRateLimitSnapshot } from "../common/provider-types";
import {
  CHATGPT_WHAM_USAGE_URL,
  readOpenAIQuotaUsage,
  type OpenAIRateLimitsWithMeta,
} from "./openai-quota";

function snapshot(overrides: Partial<QuotaRateLimitSnapshot> = {}): QuotaRateLimitSnapshot {
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

function payload(rateLimits: QuotaRateLimitSnapshot): OpenAIRateLimitsWithMeta {
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

  it("converts missing primary data and rejected lookups into lookup_failed", async () => {
    await expect(
      readOpenAIQuotaUsage(async () => payload(snapshot({ primary: null }))),
    ).resolves.toMatchObject({
      kind: "lookup_failed",
      reason: "primary usedPercent unavailable",
    });

    await expect(
      readOpenAIQuotaUsage(async () => {
        throw new Error("lookup timeout");
      }),
    ).resolves.toMatchObject({
      kind: "lookup_failed",
      reason: "lookup timeout",
    });
  });

  it("reads wham usage directly with Codex identity headers", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify(payload(snapshot()).data), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      readOpenAIQuotaUsage({
        credentials: { accessToken: "access", accountId: "acct" },
        fetch: fetchMock,
      }),
    ).resolves.toMatchObject({ kind: "ok", utilizationPct: 17 });
    expect(fetchMock).toHaveBeenCalledWith(
      CHATGPT_WHAM_USAGE_URL,
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer access",
          "ChatGPT-Account-ID": "acct",
          originator: "codex_cli_rs",
        }),
      }),
    );
  });

  it("normalizes the pinned wham rate_limit and additional_rate_limits shape", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({
        plan_type: "pro",
        credits: { balance: 12 },
        rate_limit_reached: "primary",
        rate_limits: {
          rate_limit: {
            limit_id: "primary",
            primary_window: { used_percent: 21, window_minutes: 300, reset_at: 123 },
          },
          additional_rate_limits: [{
            rate_limit: {
              limit_id: "secondary",
              primary_window: { used_percent: 4, window_minutes: 10080, reset_at: 456 },
            },
          }],
        },
      }), { status: 200 }),
    );
    const result = await readOpenAIQuotaUsage({
      credentials: { accessToken: "access", accountId: "acct" },
      fetch: fetchMock,
    });
    expect(result).toMatchObject({
      kind: "ok",
      utilizationPct: 21,
      raw: {
        rateLimits: { limitId: "primary", planType: "pro", credits: { balance: 12 }, rateLimitReachedType: "primary" },
        rateLimitsByLimitId: { secondary: { limitId: "secondary", primary: { usedPercent: 4 } } },
      },
    });
  });

  it("fails open for direct HTTP failures", async () => {
    await expect(
      readOpenAIQuotaUsage({
        credentials: { accessToken: "access", accountId: "acct" },
        fetch: async () => new Response("unavailable", { status: 503 }),
      }),
    ).resolves.toEqual({ kind: "lookup_failed", reason: "OpenAI quota lookup failed: HTTP 503" });
  });
});
