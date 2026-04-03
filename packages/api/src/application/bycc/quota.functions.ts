/**
 * 쿼터 추적 — 토큰별 5시간 윈도우 사용량 누적 + 조회.
 *
 * <project-root>/data/bycc-usage.json에 저장.
 * 매 요청마다 recordUsage()로 합산, getQuotaStatus()로 조회.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIVE_HOUR_LIMIT = 275_000; // Team Premium 추정치 (tokens)
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "../../../../..");
const DEFAULT_DIR = process.env.BYCC_TOKEN_DIR ?? join(PROJECT_ROOT, "data");
const USAGE_FILE = "bycc-usage.json";

type UsageEntry = {
  total: number;
  requests: number;
  costUsd: number;
  windowStart: string;
};

type UsageStore = Record<string, UsageEntry>;

export type QuotaInfo = {
  total: number;
  percent: number;
  resetsIn: number;
  requests: number;
  costUsd: number;
};

function getUsagePath(): string {
  return join(DEFAULT_DIR, USAGE_FILE);
}

function loadUsage(): UsageStore {
  const filePath = getUsagePath();
  if (!existsSync(filePath)) return {};

  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return {};
  }
}

function saveUsage(store: UsageStore): void {
  writeFileSync(getUsagePath(), JSON.stringify(store, null, 2), { mode: 0o600 });
}

function isWindowExpired(windowStart: string): boolean {
  return Date.now() - new Date(windowStart).getTime() > FIVE_HOURS_MS;
}

export function recordUsage(
  token: string,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
): void {
  const store = loadUsage();
  const entry = store[token] ?? {
    total: 0,
    requests: 0,
    costUsd: 0,
    windowStart: new Date().toISOString(),
  };

  // 5시간 윈도우 만료 시 리셋
  if (isWindowExpired(entry.windowStart)) {
    entry.total = 0;
    entry.requests = 0;
    entry.costUsd = 0;
    entry.windowStart = new Date().toISOString();
  }

  entry.total += inputTokens + outputTokens;
  entry.requests += 1;
  entry.costUsd += Math.round((entry.costUsd + costUsd) * 1000) / 1000 - entry.costUsd;

  store[token] = entry;
  saveUsage(store);
}

export function getQuotaStatus(token: string): QuotaInfo {
  const store = loadUsage();
  const entry = store[token];

  if (!entry || isWindowExpired(entry.windowStart)) {
    return { total: 0, percent: 0, resetsIn: 0, requests: 0, costUsd: 0 };
  }

  const elapsed = Date.now() - new Date(entry.windowStart).getTime();
  const resetsIn = Math.max(0, FIVE_HOURS_MS - elapsed);
  const percent = Math.min(100, Math.round((entry.total / FIVE_HOUR_LIMIT) * 100));

  return {
    total: entry.total,
    percent,
    resetsIn,
    requests: entry.requests,
    costUsd: entry.costUsd,
  };
}
