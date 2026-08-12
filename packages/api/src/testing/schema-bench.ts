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
  /**
   * 응답이 평문 텍스트인 계약 (tools-only 의 최종 answer 등). JSON 문법·형태 축 판정을
   * 건너뛴다 — 평문 answer 를 JSON.parse 하면 정상 응답이 syntax fail 로 둔갑한다.
   */
  plainText?: boolean;
  /**
   * fixture 의 전체 JSON Schema. 지정하면 validateAgainstSchema 로 **전체 트리**를
   * 검증한다 — top-level 키 존재만 보면 `{"scenes":[{},{},{}]}` 같은 속 빈 응답이
   * 통과한다(SON-495 교훈: 상위 키 판정은 쓰레기를 통과시킨다).
   */
  schema?: unknown;
  /** 최상위에 반드시 있어야 하는 키 (schema 미지정 시의 최소 검증) */
  requiredTopLevelKeys?: string[];
  /** 허용되는 최상위 키 전체 — 래퍼 키 판정에 사용 */
  allowedTopLevelKeys?: string[];
  /** fixture 별 추가 계약 검증. 실패 사유 문자열을 반환하면 contract fail. */
  validate?: (parsed: unknown, rawText: string) => string | undefined;
}

/**
 * 미니 JSON Schema 검증기 — 벤치 fixture(deti 실물 포함)가 실제로 쓰는 keyword 를
 * 전부 지원한다: type/enum/const/required/properties/additionalProperties/items/
 * minItems/maxItems/minLength/maxLength/anyOf/oneOf. 위반 경로 목록을 반환한다.
 * 여기 없는 keyword 는 무시된다(검증 누락은 있어도 오탐은 없다).
 */
export function validateAgainstSchema(node: unknown, schema: unknown, path = "$"): string[] {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return [];
  const sch = schema as Record<string, unknown>;
  const errors: string[] = [];

  const branches = (kw: "anyOf" | "oneOf") =>
    Array.isArray(sch[kw]) ? (sch[kw] as unknown[]) : undefined;
  for (const kw of ["anyOf", "oneOf"] as const) {
    const list = branches(kw);
    if (list && !list.some((b) => validateAgainstSchema(node, b, path).length === 0)) {
      errors.push(`${path}: no ${kw} branch matched`);
    }
  }

  const type = sch.type;
  if (type !== undefined) {
    const types = Array.isArray(type) ? type : [type];
    const matches = types.some(
      (t) =>
        (t === "object" && node !== null && typeof node === "object" && !Array.isArray(node)) ||
        (t === "array" && Array.isArray(node)) ||
        (t === "string" && typeof node === "string") ||
        (t === "number" && typeof node === "number") ||
        (t === "integer" && typeof node === "number" && Number.isInteger(node)) ||
        (t === "boolean" && typeof node === "boolean") ||
        (t === "null" && node === null),
    );
    if (!matches) {
      errors.push(`${path}: expected type ${JSON.stringify(type)}`);
      return errors; // 타입이 틀리면 하위 검증은 무의미
    }
  }

  if (Array.isArray(sch.enum) && !sch.enum.some((v) => deepEqual(v, node))) {
    errors.push(`${path}: enum violation`);
  }
  if ("const" in sch && !deepEqual(sch.const, node)) {
    errors.push(`${path}: const violation`);
  }

  if (typeof node === "string") {
    if (typeof sch.minLength === "number" && node.length < sch.minLength) {
      errors.push(`${path}: shorter than minLength ${sch.minLength}`);
    }
    if (typeof sch.maxLength === "number" && node.length > sch.maxLength) {
      errors.push(`${path}: longer than maxLength ${sch.maxLength}`);
    }
  }

  if (Array.isArray(node)) {
    if (typeof sch.minItems === "number" && node.length < sch.minItems) {
      errors.push(`${path}: fewer than minItems ${sch.minItems}`);
    }
    if (typeof sch.maxItems === "number" && node.length > sch.maxItems) {
      errors.push(`${path}: more than maxItems ${sch.maxItems}`);
    }
    if (sch.items && typeof sch.items === "object" && !Array.isArray(sch.items)) {
      node.forEach((item, i) => {
        errors.push(...validateAgainstSchema(item, sch.items, `${path}[${i}]`));
      });
    }
  }

  if (node !== null && typeof node === "object" && !Array.isArray(node)) {
    const record = node as Record<string, unknown>;
    const properties =
      sch.properties && typeof sch.properties === "object" && !Array.isArray(sch.properties)
        ? (sch.properties as Record<string, unknown>)
        : {};
    if (Array.isArray(sch.required)) {
      for (const key of sch.required) {
        if (typeof key === "string" && !Object.hasOwn(record, key)) {
          errors.push(`${path}.${key}: missing required`);
        }
      }
    }
    for (const [key, value] of Object.entries(record)) {
      if (Object.hasOwn(properties, key)) {
        errors.push(...validateAgainstSchema(value, properties[key], `${path}.${key}`));
      } else if (sch.additionalProperties === false) {
        errors.push(`${path}.${key}: additional property`);
      }
    }
  }

  return errors;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
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

  if (options.plainText) {
    const reason = options.validate?.(text, text);
    return {
      syntax: "ok",
      contract: reason === undefined ? "ok" : "fail",
      ...(reason === undefined ? {} : { contractDetail: reason }),
      topLevel: { wrapperKey: false, fenceResidue, prose: false },
    };
  }

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
    } else if (options.schema !== undefined) {
      const violations = validateAgainstSchema(parsed, options.schema);
      if (violations.length > 0) {
        contract = "fail";
        contractDetail = `${violations.length} schema violations: ${violations.slice(0, 5).join("; ")}`;
      }
    } else {
      const missing = (options.requiredTopLevelKeys ?? []).filter(
        (key) => !Object.hasOwn(record, key),
      );
      if (missing.length > 0) {
        contract = "fail";
        contractDetail = `missing required keys: ${missing.join(", ")}`;
      }
    }
    if (contract === "ok" && options.validate) {
      const reason = options.validate(parsed, text);
      if (reason !== undefined) {
        contract = "fail";
        contractDetail = reason;
      }
    }
  }

  return { syntax, contract, contractDetail, topLevel: { wrapperKey, fenceResidue, prose } };
}

// ── 레코드·checkpoint ──

export interface BenchRecord {
  fixture: string;
  /**
   * fixture 내용(prompt·schema·tools)의 지문. checkpoint 동일성에 포함된다 —
   * 이름만으로 식별하면 fixture 를 고친 뒤 재실행할 때 옛 결과가 현재 데이터로
   * 둔갑한다(pending=0). 지문이 다르면 다른 조합으로 취급돼 재발사된다.
   */
  fixtureHash?: string;
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

/** fixture 내용 지문 — djb2 (의존성 없이 충분: 충돌해 봐야 옛 레코드 하나가 스킵될 뿐). */
export function fingerprintFixture(content: {
  prompt: string;
  jsonSchema?: string;
  tools?: unknown;
}): string {
  const text = `${content.prompt} ${content.jsonSchema ?? ""} ${JSON.stringify(content.tools ?? null)}`;
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function checkpointKey(
  record: Pick<BenchRecord, "fixture" | "fixtureHash" | "model" | "mode" | "iteration">,
): string {
  return `${record.model}|${record.fixture}|${record.fixtureHash ?? "-"}|${record.mode}|${record.iteration}`;
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
    .toSorted((a, b) =>
      `${a.model}${a.fixture}${a.mode}`.localeCompare(`${b.model}${b.fixture}${b.mode}`),
    );
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
