import { type OpenAICredentials } from "../../../application/token/token.types";
import { type QuotaRateLimits, type QuotaRateLimitSnapshot } from "../common/provider-types";
import { buildCodexIdentityHeaders } from "./openai-backend-protocol";

export const CHATGPT_WHAM_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage" as const;

export type OpenAIRateLimitsWithMeta = {
  data: QuotaRateLimits;
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
      raw?: QuotaRateLimits;
    }
  | { kind: "lookup_failed"; reason: string };

export interface OpenAIQuotaHttpOptions {
  credentials: Pick<OpenAICredentials, "accessToken" | "accountId">;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

async function readDirect(options: OpenAIQuotaHttpOptions): Promise<OpenAIRateLimitsWithMeta> {
  const response = await (options.fetch ?? fetch)(CHATGPT_WHAM_USAGE_URL, {
    method: "GET",
    headers: buildCodexIdentityHeaders(
      options.credentials.accessToken,
      options.credentials.accountId,
    ),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) throw new Error(`OpenAI quota lookup failed: HTTP ${response.status}`);
  const body = (await response.json()) as Record<string, unknown>;
  const data = normalizeWhamUsage(body);
  return { data, cachedAt: Date.now() };
}

function windowFrom(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const usedPercent = Number(source.usedPercent ?? source.used_percent);
  if (!Number.isFinite(usedPercent)) return null;
  const duration = source.windowDurationMins ?? source.window_minutes;
  const resets = source.resetsAt ?? source.reset_at;
  return {
    usedPercent,
    windowDurationMins: duration === null || duration === undefined ? null : Number(duration),
    resetsAt: resets === null || resets === undefined ? null : Number(resets),
  };
}

function snapshotFrom(value: unknown): QuotaRateLimitSnapshot {
  const source = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const limitId = source.limitId ?? source.limit_id;
  const limitName = source.limitName ?? source.limit_name;
  return {
    limitId: typeof limitId === "string" ? limitId : null,
    limitName: typeof limitName === "string" ? limitName : null,
    primary: windowFrom(source.primary ?? source.primary_window),
    secondary: windowFrom(source.secondary ?? source.secondary_window),
    credits: (source.credits ?? null) as QuotaRateLimitSnapshot["credits"],
    planType:
      typeof (source.planType ?? source.plan_type) === "string"
        ? String(source.planType ?? source.plan_type)
        : null,
    rateLimitReachedType:
      typeof (source.rateLimitReachedType ?? source.rate_limit_reached) === "string"
        ? String(source.rateLimitReachedType ?? source.rate_limit_reached)
        : null,
  };
}

function normalizeWhamUsage(body: Record<string, unknown>): QuotaRateLimits {
  if (body.rateLimits && typeof body.rateLimits === "object") {
    return body as QuotaRateLimits;
  }
  const container =
    body.rate_limits && typeof body.rate_limits === "object"
      ? (body.rate_limits as Record<string, unknown>)
      : body;
  const shared = {
    plan_type: body.plan_type ?? container.plan_type,
    credits: body.credits ?? container.credits,
    rate_limit_reached: body.rate_limit_reached ?? container.rate_limit_reached,
  };
  const primary = snapshotFrom({
    ...shared,
    ...((container.rate_limit ?? container) as Record<string, unknown>),
  });
  const additional = Array.isArray(container.additional_rate_limits)
    ? container.additional_rate_limits
    : Array.isArray(body.additional_rate_limits)
      ? body.additional_rate_limits
      : [];
  const byId: Record<string, QuotaRateLimitSnapshot> = {};
  for (const entry of additional) {
    if (!entry || typeof entry !== "object") continue;
    const wrapper = entry as Record<string, unknown>;
    const snapshot = snapshotFrom({
      ...shared,
      ...((wrapper.rate_limit ?? wrapper) as Record<string, unknown>),
    });
    if (snapshot.limitId) byId[snapshot.limitId] = snapshot;
  }
  return {
    rateLimits: primary,
    rateLimitsByLimitId: Object.keys(byId).length ? byId : null,
  };
}

export async function readOpenAIQuotaUsage(
  source: (() => Promise<OpenAIRateLimitsWithMeta>) | OpenAIQuotaHttpOptions,
): Promise<OpenAIQuotaUsageResult> {
  try {
    const direct = typeof source !== "function";
    const { data, cachedAt } = await (typeof source === "function" ? source() : readDirect(source));
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
      ...(direct ? { raw: data } : {}),
    };
  } catch (e) {
    return { kind: "lookup_failed", reason: (e as Error).message };
  }
}
