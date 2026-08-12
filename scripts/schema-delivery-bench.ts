/**
 * anthropic 프롬프트 스키마 전달 준수율 벤치 (SON-532).
 *
 * qgrid HTTP API 로 실제 요청을 발사해 — 프롬프트 계약 주입 → CC 텍스트 실행 →
 * 펜스 스트리핑 → (tools 면) parseEnvelope — 새 경로 전체의 준수율을 측정한다.
 * 분류·집계·checkpoint 로직은 packages/api/src/testing/schema-bench.ts (단위 테스트로 고정).
 *
 * 기본은 dry-run 이다: 발사할 요청 수와 예상 비용만 출력한다. 실제 발사는 BENCH_LIVE=1.
 * 결과는 JSONL 로 append 되며(checkpoint), 중단 후 재실행하면 완료된 조합은 재발사되지
 * 않는다. 동시성은 BENCH_CONCURRENCY(기본 2)로 낮게 유지한다 — 토큰 풀 보호.
 *
 *   BENCH_LIVE=1 BENCH_MODELS="anthropic/claude-sonnet-4-6,anthropic/claude-opus-5" \
 *   BENCH_N=30 pnpm tsx scripts/schema-delivery-bench.ts
 *
 * 환경변수:
 *   BENCH_SERVER       기본 http://localhost:44900
 *   BENCH_MODELS       쉼표 구분 (기본 anthropic/claude-sonnet-4-6)
 *   BENCH_N            모델×fixture×mode 당 반복 수 (기본 30)
 *   BENCH_FIXTURES     쉼표 구분 필터 (기본 전부)
 *   BENCH_MODES        generate,stream (기본 둘 다)
 *   BENCH_CONCURRENCY  기본 2
 *   BENCH_OUT          checkpoint JSONL 경로 (기본 scripts/out/schema-delivery-bench.jsonl)
 *   BENCH_SCHEMA_FILE  deti 실물 스키마 JSON 파일 — 지정하면 "deti-real" fixture 추가
 *   BENCH_EST_COST_USD dry-run 의 요청당 예상 비용 (기본 0.10)
 *
 * 한계: tools fixture 의 envelope 위반은 서버(parseEnvelope)가 거절하므로 원문 텍스트가
 * 벤치에 도달하지 않는다 — 에러 메시지로 contract fail 만 집계하고 형태 축(래퍼/펜스)은
 * 서버 로그(request log)로 사후 분류한다.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  aggregateBench,
  type BenchClassifyOptions,
  type BenchMode,
  type BenchRecord,
  checkpointKey,
  classifyBenchText,
  formatAggregateTable,
  parseCheckpointLines,
} from "../packages/api/src/testing/schema-bench";

const SERVER = process.env.BENCH_SERVER ?? "http://localhost:44900";
const MODELS = (process.env.BENCH_MODELS ?? "anthropic/claude-sonnet-4-6")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
const N = Number(process.env.BENCH_N ?? "30");
const LIVE = process.env.BENCH_LIVE === "1";
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? "2");
const OUT = process.env.BENCH_OUT ?? "scripts/out/schema-delivery-bench.jsonl";
const EST_COST = Number(process.env.BENCH_EST_COST_USD ?? "0.10");
const MODES = (process.env.BENCH_MODES ?? "generate,stream")
  .split(",")
  .map((m) => m.trim())
  .filter((m): m is BenchMode => m === "generate" || m === "stream");

interface Fixture {
  name: string;
  prompt: string;
  jsonSchema?: string;
  tools?: Array<{ name: string; description?: string; inputSchema: unknown }>;
  classify: BenchClassifyOptions;
}

const SMALL_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    mood: { type: ["string", "null"], description: "낯선 분위기면 생략하지 말고 null" },
    tags: { type: "array", items: { type: "string" } },
  },
  required: ["title", "tags"],
};

// deti 근사(실물 수령 전) — 중첩 배열·enum·nullable 을 담은 축약형
const NESTED_SCHEMA = {
  type: "object",
  properties: {
    scenes: {
      type: "array",
      minItems: 3,
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          advance: { type: "string", enum: ["next", "choice"] },
          contents: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["text", "dialogue"] },
                text: { type: "string" },
                speaker: { type: ["string", "null"] },
              },
              required: ["type", "text"],
            },
          },
        },
        required: ["id", "advance", "contents"],
      },
    },
    contradiction: { type: ["string", "null"] },
  },
  required: ["scenes"],
};

const LOOKUP_TOOLS = [
  {
    name: "lookup",
    description: "Look up a case file by key",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  },
];

function buildFixtures(): Fixture[] {
  const fixtures: Fixture[] = [
    {
      name: "schema-small",
      prompt: "미스터리 단편의 제목과 태그 3개를 한국어로 지어라.",
      jsonSchema: JSON.stringify(SMALL_SCHEMA),
      classify: {
        requiredTopLevelKeys: ["title", "tags"],
        allowedTopLevelKeys: Object.keys(SMALL_SCHEMA.properties),
      },
    },
    {
      name: "schema-nested",
      prompt: [
        "미스터리 게임 한 턴을 한국어로 생성하라. 장면 3개 이상.",
        "배경: 백월관 대식당, 오래된 극단, 이름이 긁힌 1976년 단체 사진.",
      ].join("\n"),
      jsonSchema: JSON.stringify(NESTED_SCHEMA),
      classify: {
        requiredTopLevelKeys: ["scenes"],
        allowedTopLevelKeys: Object.keys(NESTED_SCHEMA.properties),
        validate: (parsed) => {
          const scenes = (parsed as { scenes?: unknown }).scenes;
          if (!Array.isArray(scenes) || scenes.length < 3) return "scenes must have >= 3 items";
          return undefined;
        },
      },
    },
    {
      name: "tools-only",
      prompt: "사건 파일 'case-1976' 을 조회해서 요약하라.",
      tools: LOOKUP_TOOLS,
      // 서버 parseEnvelope 통과가 계약이다 — 성공 응답이면 contract ok 로 기록된다
      classify: {},
    },
    {
      name: "tools-with-schema",
      prompt: "사건 파일 'case-1976' 을 조회해 제목과 태그를 정리하라.",
      tools: LOOKUP_TOOLS,
      jsonSchema: JSON.stringify(SMALL_SCHEMA),
      classify: {
        requiredTopLevelKeys: ["title", "tags"],
        allowedTopLevelKeys: Object.keys(SMALL_SCHEMA.properties),
      },
    },
  ];

  const schemaFile = process.env.BENCH_SCHEMA_FILE;
  if (schemaFile) {
    const raw = JSON.parse(readFileSync(schemaFile, "utf8")) as {
      type: string;
      properties?: Record<string, unknown>;
      required?: string[];
    };
    fixtures.push({
      name: "deti-real",
      prompt:
        "미스터리 게임 한 턴을 한국어로 생성하라. 모든 필수 필드를 채우고 모르는 nullable 값은 null 로 두라.",
      jsonSchema: JSON.stringify(raw),
      classify: {
        requiredTopLevelKeys: raw.required ?? [],
        allowedTopLevelKeys: raw.properties ? Object.keys(raw.properties) : undefined,
      },
    });
  }

  const filter = new Set(
    (process.env.BENCH_FIXTURES ?? "")
      .split(",")
      .map((f) => f.trim())
      .filter(Boolean),
  );
  return filter.size > 0 ? fixtures.filter((f) => filter.has(f.name)) : fixtures;
}

interface QueryResponse {
  text: string;
  finishReason: string;
  usage?: { output_tokens?: number };
  costUsd?: number;
  content?: Array<{ type: string; toolName?: string }>;
}

async function fireGenerate(fixture: Fixture, model: string): Promise<{
  text?: string;
  finishReason?: string;
  outputTokens?: number;
  costUsd?: number;
  transportError?: string;
}> {
  const res = await fetch(`${SERVER}/api/qgrid/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prompt: fixture.prompt,
      model,
      projectName: "schema-delivery-bench",
      ...(fixture.jsonSchema ? { jsonSchema: fixture.jsonSchema } : {}),
      ...(fixture.tools ? { tools: fixture.tools } : {}),
    }),
  });
  if (!res.ok) {
    return { transportError: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` };
  }
  const data = (await res.json()) as QueryResponse;
  return {
    text: data.text,
    finishReason: data.finishReason,
    outputTokens: data.usage?.output_tokens,
    costUsd: data.costUsd,
  };
}

async function fireStream(fixture: Fixture, model: string): Promise<{
  deltaText?: string;
  doneText?: string;
  finishReason?: string;
  outputTokens?: number;
  costUsd?: number;
  transportError?: string;
}> {
  const prep = await fetch(`${SERVER}/api/qgrid/prepareStream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prompt: fixture.prompt,
      model,
      projectName: "schema-delivery-bench",
      ...(fixture.jsonSchema ? { jsonSchema: fixture.jsonSchema } : {}),
      ...(fixture.tools ? { tools: fixture.tools } : {}),
    }),
  });
  if (!prep.ok) {
    return { transportError: `prepareStream HTTP ${prep.status}: ${(await prep.text()).slice(0, 300)}` };
  }
  const { streamId } = (await prep.json()) as { streamId: string };

  const res = await fetch(`${SERVER}/api/qgrid/queryStream?streamId=${streamId}`);
  if (!res.ok || !res.body) {
    return { transportError: `queryStream HTTP ${res.status}` };
  }

  let deltaText = "";
  let done: QueryResponse | undefined;
  let streamError: string | undefined;
  let eventName = "";
  let buffer = "";

  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trimEnd();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (eventName === "delta") {
        deltaText += (JSON.parse(payload) as { text: string }).text;
      } else if (eventName === "done") {
        done = JSON.parse(payload) as QueryResponse;
      } else if (eventName === "error") {
        streamError = (JSON.parse(payload) as { message: string }).message;
      }
    }
  }

  if (streamError !== undefined) return { transportError: `stream error: ${streamError}` };
  return {
    deltaText,
    doneText: done?.text,
    finishReason: done?.finishReason,
    outputTokens: done?.usage?.output_tokens,
    costUsd: done?.costUsd,
  };
}

async function runOne(
  fixture: Fixture,
  model: string,
  mode: BenchMode,
  iteration: number,
): Promise<BenchRecord> {
  const start = Date.now();
  const base = { fixture: fixture.name, model, mode, iteration };

  try {
    if (mode === "generate") {
      const r = await fireGenerate(fixture, model);
      if (r.transportError !== undefined) {
        return { ...base, transportError: r.transportError, durationMs: Date.now() - start };
      }
      return {
        ...base,
        // tool_call 로 끝난 tools fixture 는 envelope 계약 통과 자체가 성공이다
        classification:
          r.finishReason === "tool-calls"
            ? {
                syntax: "ok",
                contract: "ok",
                topLevel: { wrapperKey: false, fenceResidue: false, prose: false },
              }
            : classifyBenchText(r.text ?? "", fixture.classify),
        durationMs: Date.now() - start,
        outputTokens: r.outputTokens,
        costUsd: r.costUsd,
      };
    }

    const r = await fireStream(fixture, model);
    if (r.transportError !== undefined) {
      return { ...base, transportError: r.transportError, durationMs: Date.now() - start };
    }
    return {
      ...base,
      classification:
        r.finishReason === "tool-calls"
          ? {
              syntax: "ok",
              contract: "ok",
              topLevel: { wrapperKey: false, fenceResidue: false, prose: false },
            }
          : classifyBenchText(r.doneText ?? "", fixture.classify),
      // 펜스 transform 불변식의 실전 검증 — 델타 연결과 done.text 는 같아야 한다
      deltaDoneMismatch:
        r.finishReason !== "tool-calls" && (r.deltaText ?? "") !== (r.doneText ?? ""),
      durationMs: Date.now() - start,
      outputTokens: r.outputTokens,
      costUsd: r.costUsd,
    };
  } catch (error) {
    return {
      ...base,
      transportError: (error as Error).message.slice(0, 300),
      durationMs: Date.now() - start,
    };
  }
}

async function main(): Promise<void> {
  const fixtures = buildFixtures();
  const tasks: Array<{ fixture: Fixture; model: string; mode: BenchMode; iteration: number }> = [];
  for (const model of MODELS) {
    for (const fixture of fixtures) {
      for (const mode of MODES) {
        for (let i = 0; i < N; i += 1) tasks.push({ fixture, model, mode, iteration: i });
      }
    }
  }

  const completed = existsSync(OUT)
    ? parseCheckpointLines(readFileSync(OUT, "utf8"))
    : new Map<string, BenchRecord>();
  const pending = tasks.filter(
    (t) => !completed.has(checkpointKey({ ...t, fixture: t.fixture.name })),
  );

  console.log(
    [
      `server=${SERVER}`,
      `models=${MODELS.join(",")}`,
      `fixtures=${fixtures.map((f) => f.name).join(",")}`,
      `modes=${MODES.join(",")}`,
      `N=${N}`,
      `total=${tasks.length}`,
      `completed=${completed.size}`,
      `pending=${pending.length}`,
      `estCost≈$${(pending.length * EST_COST).toFixed(2)}`,
      `out=${OUT}`,
    ].join(" "),
  );

  if (!LIVE) {
    console.log("dry-run 입니다. 실제 발사는 BENCH_LIVE=1 을 붙이세요.");
    return;
  }

  mkdirSync(dirname(OUT), { recursive: true });
  let fired = 0;
  const queue = [...pending];
  const workers = Array.from({ length: Math.max(1, CONCURRENCY) }, async () => {
    for (;;) {
      const task = queue.shift();
      if (!task) return;
      const record = await runOne(task.fixture, task.model, task.mode, task.iteration);
      appendFileSync(OUT, `${JSON.stringify(record)}\n`);
      fired += 1;
      const status = record.transportError
        ? `transport✗ ${record.transportError.slice(0, 80)}`
        : `${record.classification?.syntax}/${record.classification?.contract}`;
      console.log(
        `[${fired}/${pending.length}] ${task.model} ${task.fixture.name} ${task.mode}#${task.iteration} ${status} ${record.durationMs}ms`,
      );
    }
  });
  await Promise.all(workers);

  const all = parseCheckpointLines(readFileSync(OUT, "utf8"));
  console.log(`\n${formatAggregateTable(aggregateBench([...all.values()]))}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
