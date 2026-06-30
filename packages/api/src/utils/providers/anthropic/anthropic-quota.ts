import { fetchUsageWithMeta } from "../../../application/qgrid/oauth";

export type AnthropicQuotaUsageResult =
  | { kind: "ok"; utilizationPct: number; cacheAgeMs: number }
  | { kind: "lookup_failed"; reason: string };

export async function readAnthropicQuotaUsage(
  accessToken: string,
): Promise<AnthropicQuotaUsageResult> {
  try {
    const { data, cachedAt } = await fetchUsageWithMeta(accessToken);
    if (data.error) return { kind: "lookup_failed", reason: data.error };

    const utilization = data.five_hour?.utilization;
    if (typeof utilization !== "number" || !Number.isFinite(utilization)) {
      return { kind: "lookup_failed", reason: "five_hour utilization unavailable" };
    }

    return {
      kind: "ok",
      utilizationPct: utilization,
      cacheAgeMs: Math.max(Date.now() - cachedAt, 0),
    };
  } catch (e) {
    return { kind: "lookup_failed", reason: (e as Error).message };
  }
}
