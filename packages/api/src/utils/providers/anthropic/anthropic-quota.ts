import {
  fetchUsageWithMeta,
  invalidateAnthropicQuotaUsage,
} from "../../../application/qgrid/oauth";
import { isFableFamilyModel } from "./anthropic-constants";

export { invalidateAnthropicQuotaUsage };

export type AnthropicQuotaUsageResult =
  | { kind: "ok"; utilizationPct: number; cacheAgeMs: number }
  | { kind: "lookup_failed"; reason: string };

export async function readAnthropicQuotaUsage(
  accessToken: string,
  model?: string,
): Promise<AnthropicQuotaUsageResult> {
  try {
    const { data, cachedAt } = await fetchUsageWithMeta(accessToken);
    if (data.error) return { kind: "lookup_failed", reason: data.error };

    const utilizations = [data.five_hour?.utilization];
    // Fable 계열(5, 5.1)은 5시간 창과 별개로 usage credits 기반 7일 버킷도 소진될 수 있다.
    if (isFableFamilyModel(model)) {
      utilizations.push(data.seven_day_overage_included?.utilization);
    }
    const utilization = Math.max(
      ...utilizations.filter(
        (value): value is number => typeof value === "number" && Number.isFinite(value),
      ),
    );
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
