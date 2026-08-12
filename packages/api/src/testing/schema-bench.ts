/**
 * schema-delivery 준수율 벤치의 순수 로직 (SON-532).
 *
 * 러너(scripts/schema-delivery-bench.ts)는 qgrid HTTP API 로 실제 요청을 발사하고,
 * 이 모듈은 응답 분류·집계·checkpoint 를 담당한다 — 벤치 결과의 신뢰가 집계 정확성에
 * 걸려 있으므로 이 부분만 단위 테스트로 고정한다.
 *
 * 실패 분류는 서로 배타적인 3계층이다 (Codex 검토 반영 — 중복 판정 금지):
 *   1. syntax   — JSON.parse 실패
 *   2. contract — 파싱은 됐으나 계약(필수 키·fixture validate) 불통과. 필드 누락은 여기.
 *   3. (별도 축) topLevel — 래퍼 키(GEN-359 병리)·펜스 잔존·프로즈. 형태 축이라
 *      syntax/contract 와 겹칠 수 있고, 게이트 계수는 이 축 기준이다.
 */

export type BenchMode = "generate" | "stream";

export interface BenchClassifyOptions {
  /** 최상위에 반드시 있어야 하는 키 (schema fixture 의 required) */
  requiredTopLevelKeys?: string[];
  /** 허용되는 최상위 키 전체 — 래퍼 키 판정에 사용 */
  allowedTopLevelKeys?: string[];
  /** fixture 별 추가 계약 검증. 실패 사유 문자열을 반환하면 contract fail. */
  validate?: (parsed: unknown, rawText: string) => string | undefined;
}

export interface TopLevelViolations {
  /** 최상위가 허용 키 목록 밖의 단일 키로 감싸져 있음 — GEN-359 래퍼 키 병리 */
  wrapperKey: boolean;
  /** 서버 스트리핑 후에도 ``` 가 양끝에 남아 있음 */
  fenceResidue: boolean;
  /** JSON 이 아닌 산문으로 시작 */
  prose: boolean;
}

export interface BenchClassification {
  syntax: "ok" | "fail";
  /** syntax fail 이면 계약 검증 자체가 불가 — "n/a" */
  contract: "ok" | "fail" | "n/a";
  contractDetail?: string;
  topLevel: TopLevelViolations;
}

export function classifyBenchText(
  text: string,
  options: BenchClassifyOptions = {},
): BenchClassification {
  const trimmed = text.trim();
  const fenceResidue = trimmed.startsWith("```") || trimmed.endsWith("```");

  let parsed: unknown;
  let syntax: "ok" | "fail" = "ok";
  try {
    parsed = JSON.parse(text);
  } catch {
    syntax = "fail";
  }

  const prose = syntax === "fail" && !fenceResidue && !/^[{[]/.test(trimmed);

  let wrapperKey = false;
  let contract: BenchClassification["contract"] = "n/a";
  let contractDetail: string | undefined;

  if (syntax === "ok") {
    const record =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;

    if (record && options.allowedTopLevelKeys) {
      const keys = Object.keys(record);
      const allowed = new Set(options.allowedTopLevelKeys);
      wrapperKey =
        keys.length === 1 &&
        !allowed.has(keys[0]!) &&
        typeof record[keys[0]!] === "object" &&
        record[keys[0]!] !== null;
    }

    contract = "ok";
    if (record === undefined) {
      contract = "fail";
      contractDetail = "top-level is not an object";
    } else {
      const missing = (options.requiredTopLevelKeys ?? []).filter(
        (key) => !Object.hasOwn(record, key),
      );
      if (missing.length > 0) {
        contract = "fail";
        contractDetail = `missing required keys: ${missing.join(", ")}`;
      } else if (options.validate) {
        const reason = options.validate(parsed, text);
        if (reason !== undefined) {
          contract = "fail";
          contractDetail = reason;
        }
      }
    }
  }

  return { syntax, contract, contractDetail, topLevel: { wrapperKey, fenceResidue, prose } };
}

// ── 레코드·checkpoint ──

export interface BenchRecord {
  fixture: string;
  model: string;
  mode: BenchMode;
  iteration: number;
  /** HTTP/전송 오류 포함 전체 요청이 분모다 — 오류를 분모에서 빼면 오류율 차이가 은폐된다. */
  transportError?: string;
  classification?: BenchClassification;
  /** 스트림에서 델타 연결과 done.text 가 달랐는지 (펜스 transform 불변식의 실전 검증) */
  deltaDoneMismatch?: boolean;
  durationMs: number;
  outputTokens?: number;
  costUsd?: number;
}

export function checkpointKey(
  record: Pick<BenchRecord, "fixture" | "model" | "mode" | "iteration">,
): string {
  return `${record.model}|${record.fixture}|${record.mode}|${record.iteration}`;
}

/** JSONL checkpoint 파일 파싱. 깨진 줄(중단 시 부분 기록)은 건너뛴다. */
export function parseCheckpointLines(jsonl: string): Map<string, BenchRecord> {
  const map = new Map<string, BenchRecord>();
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as BenchRecord;
      map.set(checkpointKey(record), record);
    } catch {
      // 부분 기록된 마지막 줄 — resume 시 해당 조합만 재발사된다
    }
  }
  return map;
}

// ── 집계 ──

export interface BenchAggregateRow {
  model: string;
  fixture: string;
  mode: BenchMode;
  total: number;
  transportErrors: number;
  syntaxFails: number;
  contractFails: number;
  wrapperKey: number;
  fenceResidue: number;
  prose: number;
  deltaDoneMismatches: number;
  passes: number;
  /** 분모는 전체 요청(전송 오류 포함) */
  passRate: number;
  avgDurationMs: number;
  totalOutputTokens: number;
  totalCostUsd: number;
}

export function aggregateBench(records: BenchRecord[]): BenchAggregateRow[] {
  const groups = new Map<string, BenchRecord[]>();
  for (const record of records) {
    const key = `${record.model}|${record.fixture}|${record.mode}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(record);
    else groups.set(key, [record]);
  }

  return [...groups.entries()]
    .map(([key, bucket]) => {
      const [model, fixture, mode] = key.split("|") as [string, string, BenchMode];
      const transportErrors = bucket.filter((r) => r.transportError !== undefined).length;
      const syntaxFails = bucket.filter((r) => r.classification?.syntax === "fail").length;
      const contractFails = bucket.filter((r) => r.classification?.contract === "fail").length;
      const passes = bucket.filter(
        (r) =>
          r.transportError === undefined &&
          r.classification?.syntax === "ok" &&
          r.classification.contract === "ok",
      ).length;
      const count = (pick: (v: TopLevelViolations) => boolean) =>
        bucket.filter((r) => r.classification !== undefined && pick(r.classification.topLevel))
          .length;

      return {
        model,
        fixture,
        mode,
        total: bucket.length,
        transportErrors,
        syntaxFails,
        contractFails,
        wrapperKey: count((v) => v.wrapperKey),
        fenceResidue: count((v) => v.fenceResidue),
        prose: count((v) => v.prose),
        deltaDoneMismatches: bucket.filter((r) => r.deltaDoneMismatch === true).length,
        passes,
        passRate: bucket.length === 0 ? 0 : passes / bucket.length,
        avgDurationMs:
          bucket.length === 0
            ? 0
            : Math.round(bucket.reduce((sum, r) => sum + r.durationMs, 0) / bucket.length),
        totalOutputTokens: bucket.reduce((sum, r) => sum + (r.outputTokens ?? 0), 0),
        totalCostUsd: bucket.reduce((sum, r) => sum + (r.costUsd ?? 0), 0),
      };
    })
    .sort((a, b) => `${a.model}${a.fixture}${a.mode}`.localeCompare(`${b.model}${b.fixture}${b.mode}`));
}

export function formatAggregateTable(rows: BenchAggregateRow[]): string {
  const header = [
    "model",
    "fixture",
    "mode",
    "N",
    "pass",
    "rate",
    "syntax✗",
    "contract✗",
    "wrapper",
    "fence",
    "prose",
    "transport✗",
    "Δ≠done",
    "avgMs",
    "outTok",
    "cost$",
  ];
  const lines = rows.map((r) =>
    [
      r.model,
      r.fixture,
      r.mode,
      r.total,
      r.passes,
      `${(r.passRate * 100).toFixed(1)}%`,
      r.syntaxFails,
      r.contractFails,
      r.wrapperKey,
      r.fenceResidue,
      r.prose,
      r.transportErrors,
      r.deltaDoneMismatches,
      r.avgDurationMs,
      r.totalOutputTokens,
      r.totalCostUsd.toFixed(4),
    ].join("\t"),
  );
  return [header.join("\t"), ...lines].join("\n");
}
