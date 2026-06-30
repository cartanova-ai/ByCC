import { type GetAccountRateLimitsResponse } from "../../../codex-protocol/v2/GetAccountRateLimitsResponse";

export type OpenAIRateLimitsWithMeta = {
  data: GetAccountRateLimitsResponse;
  cachedAt: number;
};

export type OpenAIQuotaUsageResult =
  | {
      kind: "ok";
      utilizationPct: number;
      cacheAgeMs: number;
      windowDurationMins: number | null;
      resetsAt: number | null;
      limitId: string | null;
    }
  | { kind: "lookup_failed"; reason: string };

export async function readOpenAIQuotaUsage(
  readRateLimits: () => Promise<OpenAIRateLimitsWithMeta>,
): Promise<OpenAIQuotaUsageResult> {
  try {
    const { data, cachedAt } = await readRateLimits();
    const rateLimits = data.rateLimits;
    const primary = rateLimits?.primary;

    if (
      !primary ||
      typeof primary.usedPercent !== "number" ||
      !Number.isFinite(primary.usedPercent)
    ) {
      return { kind: "lookup_failed", reason: "primary usedPercent unavailable" };
    }

    return {
      kind: "ok",
      utilizationPct: primary.usedPercent,
      cacheAgeMs: Math.max(Date.now() - cachedAt, 0),
      windowDurationMins: primary.windowDurationMins,
      resetsAt: primary.resetsAt,
      limitId: rateLimits.limitId,
    };
  } catch (e) {
    return { kind: "lookup_failed", reason: (e as Error).message };
  }
}
