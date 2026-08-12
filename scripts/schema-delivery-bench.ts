/**
 * anthropic 프롬프트 스키마 전달 준수율 벤치 (SON-532).
 *
 * qgrid HTTP API 로 실제 요청을 발사해 — 프롬프트 계약 주입 → CC 텍스트 실행 →
 * 펜스 스트리핑 → (tools 면) parseEnvelope — 새 경로 전체의 준수율을 측정한다.
 * 분류·집계·checkpoint 로직은 packages/api/src/testing/schema-bench.ts (단위 테스트로 고정).
 *
 * 기본은 dry-run 이다: 발사할 요청 수와 예상 비용만 출력한다. 실제 발사는 BENCH_LIVE=1.
 * 결과는 JSONL 로 append 되며(checkpoint), 중단 후 재실행하면 완료된 조합은 재발사되지
 * 않는다. checkpoint 동일성에는 fixture 내용 지문이 포함된다 — 프롬프트/스키마/tools 를
 * 고치면 옛 결과는 무시되고 재발사된다. 동시성은 BENCH_CONCURRENCY(기본 2)로 낮게 유지.
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
 *   BENCH_TIMEOUT_MS   요청당 마감 (기본 900000 = 15분)
 *   BENCH_OUT          checkpoint JSONL 경로 (기본 scripts/out/schema-delivery-bench.jsonl)
 *   BENCH_SCHEMA_FILE  deti 실물 스키마 JSON 파일 — 지정하면 "deti-real" fixture 추가
 *   BENCH_EST_COST_USD dry-run 의 요청당 예상 비용 (기본 0.10)
 *
 * tools fixture 는 tool-calls 응답에서 멈추지 않는다: 인자를 inputSchema 로 검증하고,
 * 결정적 tool 결과로 후속 턴을 이어가(최대 3턴) 최종 answer 까지 분류한다 — 첫 tool-calls
 * 를 성공으로 치면 계약의 절반(최종 답변)이 미검증으로 남고 request log 에 열린 run 이 쌓인다.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  aggregateBench,
  type BenchClassification,
  type BenchClassifyOptions,
  type BenchMode,
  type BenchRecord,
  checkpointKey,
  classifyBenchText,
  fingerprintFixture,
  formatAggregateTable,
  parseCheckpointLines,
  validateAgainstSchema,
} from "../packages/api/src/testing/schema-bench";

const SERVER = process.env.BENCH_SERVER ?? "http://localhost:44900";
const MODELS = (process.env.BENCH_MODELS ?? "anthropic/claude-sonnet-4-6")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
const N = Number(process.env.BENCH_N ?? "30");
const LIVE = process.env.BENCH_LIVE === "1";
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? "2");
const TIMEOUT_MS = Number(process.env.BENCH_TIMEOUT_MS ?? "900000");
const OUT = process.env.BENCH_OUT ?? "scripts/out/schema-delivery-bench.jsonl";
const EST_COST = Number(process.env.BENCH_EST_COST_USD ?? "0.10");
const MODES = (process.env.BENCH_MODES ?? "generate,stream")
  .split(",")
  .map((m) => m.trim())
  .filter((m): m is BenchMode => m === "generate" || m === "stream");
const MAX_TOOL_TURNS = 3;

interface BenchTool {
  name: string;
  description?: string;
  inputSchema: unknown;
}

interface Fixture {
  name: string;
  prompt: string;
  jsonSchema?: string;
  tools?: BenchTool[];
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

const LOOKUP_TOOLS: BenchTool[] = [
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

// tool 실행 결과로 되돌려줄 결정적 응답 (매 턴 동일 — 재현성)
const LOOKUP_RESULT = JSON.stringify({
  key: "case-1976",
  title: "1976년 단체 사진 사건",
  summary: "백월관 대식당에서 발견된 오래된 극단의 단체 사진. 한 명의 이름이 긁혀 있다.",
  tags: ["미스터리", "극단", "사진"],
});

function buildFixtures(): Fixture[] {
  const fixtures: Fixture[] = [
    {
      name: "schema-small",
      prompt: "미스터리 단편의 제목과 태그 3개를 한국어로 지어라.",
      jsonSchema: JSON.stringify(SMALL_SCHEMA),
      classify: {
        schema: SMALL_SCHEMA,
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
        schema: NESTED_SCHEMA,
        allowedTopLevelKeys: Object.keys(NESTED_SCHEMA.properties),
      },
    },
    {
      name: "tools-only",
      prompt: "사건 파일 'case-1976' 을 조회해서 요약하라.",
      tools: LOOKUP_TOOLS,
      // 최종 answer 는 평문 — envelope 계약(parseEnvelope) 통과 + 비어있지 않으면 ok
      classify: {
        validate: (_parsed, raw) => (raw.trim().length > 0 ? undefined : "empty final answer"),
      },
    },
    {
      name: "tools-with-schema",
      prompt: "사건 파일 'case-1976' 을 조회해 제목과 태그를 정리하라.",
      tools: LOOKUP_TOOLS,
      jsonSchema: JSON.stringify(SMALL_SCHEMA),
      classify: {
        schema: SMALL_SCHEMA,
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
        schema: raw,
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

// ── HTTP ──

interface ToolCallContent {
  type: string;
  toolCallId?: string;
  toolName?: string;
  input?: string;
}

interface QueryResponse {
  text: string;
  finishReason: string;
  usage?: { output_tokens?: number };
  costUsd?: number;
  content?: ToolCallContent[];
  runContext?: unknown;
}

interface TurnArgs {
  prompt: string;
  system?: string;
  model: string;
  jsonSchema?: string;
  tools?: BenchTool[];
  /** AI SDK 계약: 연속턴은 전체 대화 history 를 함께 보낸다 (anthropic cold 주입) */
  history?: string;
  runContext?: unknown;
  toolResults?: Array<{ toolCallId: string; toolName?: string; output: string }>;
}

// sonamu @api 규약: 파라미터는 { args: QueryInput } 로 감싼다 (AI SDK 와 동일 wire shape)
function wireBody(turn: TurnArgs): string {
  return JSON.stringify({ args: { ...turn, projectName: "schema-delivery-bench" } });
}

interface TurnResult {
  text?: string;
  deltaText?: string;
  finishReason?: string;
  content?: ToolCallContent[];
  runContext?: unknown;
  outputTokens?: number;
  costUsd?: number;
  transportError?: string;
}

async function fireGenerate(turn: TurnArgs): Promise<TurnResult> {
  const res = await fetch(`${SERVER}/api/qgrid/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: wireBody(turn),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    return { transportError: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` };
  }
  const data = (await res.json()) as QueryResponse;
  return {
    text: data.text,
    finishReason: data.finishReason,
    content: data.content,
    runContext: data.runContext,
    outputTokens: data.usage?.output_tokens,
    costUsd: data.costUsd,
  };
}

async function fireStream(turn: TurnArgs): Promise<TurnResult> {
  const prep = await fetch(`${SERVER}/api/qgrid/prepareStream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: wireBody(turn),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!prep.ok) {
    return {
      transportError: `prepareStream HTTP ${prep.status}: ${(await prep.text()).slice(0, 300)}`,
    };
  }
  const { streamId } = (await prep.json()) as { streamId: string };

  const res = await fetch(`${SERVER}/api/qgrid/queryStream?streamId=${streamId}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
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
  // done 없이 닫힌 스트림은 서버/네트워크 실패다 — 빈 문자열을 스키마 실패로 분류하면
  // 전송 문제가 모델 준수 문제로 둔갑한다.
  if (done === undefined) {
    return { transportError: "premature EOF: stream closed without done event" };
  }
  return {
    text: done.text,
    deltaText,
    finishReason: done.finishReason,
    content: done.content,
    runContext: done.runContext,
    outputTokens: done.usage?.output_tokens,
    costUsd: done.costUsd,
  };
}

// ── 실행 (tool 연속턴 포함) ──

function contractOk(): BenchClassification {
  return {
    syntax: "ok",
    contract: "ok",
    topLevel: { wrapperKey: false, fenceResidue: false, prose: false },
  };
}

function contractFail(detail: string): BenchClassification {
  return {
    syntax: "ok",
    contract: "fail",
    contractDetail: detail,
    topLevel: { wrapperKey: false, fenceResidue: false, prose: false },
  };
}

async function runOne(
  fixture: Fixture,
  fixtureHash: string,
  model: string,
  mode: BenchMode,
  iteration: number,
): Promise<BenchRecord> {
  const start = Date.now();
  const base = { fixture: fixture.name, fixtureHash, model, mode, iteration };
  const fire = mode === "generate" ? fireGenerate : fireStream;

  let outputTokens = 0;
  let costUsd = 0;
  let deltaDoneMismatch: boolean | undefined;

  try {
    let turn: TurnArgs = {
      prompt: fixture.prompt,
      model,
      ...(fixture.jsonSchema ? { jsonSchema: fixture.jsonSchema } : {}),
      ...(fixture.tools ? { tools: fixture.tools } : {}),
    };
    // AI SDK 와 동일한 history 원장 — 연속턴에서 모델이 원 질문과 자신의 tool call 을
    // 다시 보게 한다. 이것 없이 toolResults 만 보내면 모델은 맥락 없는 tool 결과만
    // 받아 envelope 계약을 잊는다 (실측: tools-only 연속턴 프로즈 응답).
    const historyItems: unknown[] = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: fixture.prompt }],
      },
    ];

    for (let turnIndex = 0; ; turnIndex += 1) {
      const r = await fire(turn);
      outputTokens += r.outputTokens ?? 0;
      costUsd += r.costUsd ?? 0;
      if (r.transportError !== undefined) {
        return {
          ...base,
          transportError: r.transportError,
          durationMs: Date.now() - start,
          outputTokens,
          costUsd,
        };
      }
      // 델타==done 검사는 스키마 전용 fixture 에서만 유효하다 — tools 응답의 델타는
      // envelope 원문(펜스만 벗긴)이고 done.text 는 parseEnvelope 가 추출한 answer 라
      // 다른 것이 설계다(클라이언트 EnvelopeStreamParser 가 델타에서 직접 파싱).
      if (mode === "stream" && !fixture.tools && r.finishReason !== "tool-calls") {
        deltaDoneMismatch = (r.deltaText ?? "") !== (r.text ?? "");
      }

      if (r.finishReason !== "tool-calls") {
        // 최종 answer — fixture 계약 전체로 분류
        return {
          ...base,
          classification: classifyBenchText(r.text ?? "", fixture.classify),
          deltaDoneMismatch,
          durationMs: Date.now() - start,
          outputTokens,
          costUsd,
        };
      }

      // tool-calls: 인자를 inputSchema 로 검증하고 결정적 결과로 후속 턴을 잇는다
      if (turnIndex + 1 >= MAX_TOOL_TURNS) {
        return {
          ...base,
          classification: contractFail(`tool loop exceeded ${MAX_TOOL_TURNS} turns`),
          durationMs: Date.now() - start,
          outputTokens,
          costUsd,
        };
      }

      const calls = (r.content ?? []).filter((c) => c.type === "tool-call");
      if (calls.length === 0) {
        return {
          ...base,
          classification: contractFail("finishReason=tool-calls but no tool-call content"),
          durationMs: Date.now() - start,
          outputTokens,
          costUsd,
        };
      }
      for (const call of calls) {
        const tool = fixture.tools?.find((t) => t.name === call.toolName);
        if (!tool) {
          return {
            ...base,
            classification: contractFail(`unknown tool in call: ${call.toolName}`),
            durationMs: Date.now() - start,
            outputTokens,
            costUsd,
          };
        }
        let parsedArgs: unknown;
        try {
          parsedArgs = JSON.parse(call.input ?? "");
        } catch {
          return {
            ...base,
            classification: contractFail(`tool args are not JSON: ${call.toolName}`),
            durationMs: Date.now() - start,
            outputTokens,
            costUsd,
          };
        }
        const violations = validateAgainstSchema(parsedArgs, tool.inputSchema);
        if (violations.length > 0) {
          return {
            ...base,
            classification: contractFail(
              `tool args violate inputSchema (${call.toolName}): ${violations.slice(0, 3).join("; ")}`,
            ),
            durationMs: Date.now() - start,
            outputTokens,
            costUsd,
          };
        }
      }

      for (const call of calls) {
        historyItems.push({
          type: "function_call",
          name: call.toolName,
          arguments: call.input ?? "",
          call_id: call.toolCallId ?? "",
        });
        historyItems.push({
          type: "function_call_output",
          call_id: call.toolCallId ?? "",
          output: LOOKUP_RESULT,
        });
      }

      turn = {
        prompt: fixture.prompt,
        model,
        ...(fixture.jsonSchema ? { jsonSchema: fixture.jsonSchema } : {}),
        ...(fixture.tools ? { tools: fixture.tools } : {}),
        history: JSON.stringify(historyItems),
        runContext: r.runContext,
        toolResults: calls.map((call) => ({
          toolCallId: call.toolCallId ?? "",
          toolName: call.toolName,
          output: LOOKUP_RESULT,
        })),
      };
    }
  } catch (error) {
    return {
      ...base,
      transportError: (error as Error).message.slice(0, 300),
      durationMs: Date.now() - start,
      outputTokens,
      costUsd,
    };
  }
}

// ── main ──

/** 중단으로 잘린 마지막 줄이 있으면 개행으로 봉인 — 다음 append 가 그 조각에 붙어
 * 두 레코드가 한 줄로 뭉치면, 유효했던 레코드까지 스킵돼 유료 요청이 반복된다. */
function repairCheckpointTail(path: string): void {
  if (!existsSync(path)) return;
  const content = readFileSync(path, "utf8");
  if (content.length > 0 && !content.endsWith("\n")) {
    appendFileSync(path, "\n");
  }
}

async function main(): Promise<void> {
  const fixtures = buildFixtures();
  const hashes = new Map(
    fixtures.map((f) => [
      f.name,
      fingerprintFixture({ prompt: f.prompt, jsonSchema: f.jsonSchema, tools: f.tools }),
    ]),
  );
  const tasks: Array<{ fixture: Fixture; model: string; mode: BenchMode; iteration: number }> = [];
  for (const model of MODELS) {
    for (const fixture of fixtures) {
      for (const mode of MODES) {
        for (let i = 0; i < N; i += 1) tasks.push({ fixture, model, mode, iteration: i });
      }
    }
  }

  repairCheckpointTail(OUT);
  const completed = existsSync(OUT)
    ? parseCheckpointLines(readFileSync(OUT, "utf8"))
    : new Map<string, BenchRecord>();
  const pending = tasks.filter(
    (t) =>
      !completed.has(
        checkpointKey({
          fixture: t.fixture.name,
          fixtureHash: hashes.get(t.fixture.name),
          model: t.model,
          mode: t.mode,
          iteration: t.iteration,
        }),
      ),
  );

  console.log(
    [
      `server=${SERVER}`,
      `models=${MODELS.join(",")}`,
      `fixtures=${fixtures.map((f) => `${f.name}@${hashes.get(f.name)}`).join(",")}`,
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
      const record = await runOne(
        task.fixture,
        hashes.get(task.fixture.name)!,
        task.model,
        task.mode,
        task.iteration,
      );
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

  // 집계는 현재 fixture 지문과 일치하는 레코드만 — 옛 지문의 잔재는 표에서 제외
  const all = [...parseCheckpointLines(readFileSync(OUT, "utf8")).values()].filter(
    (r) => hashes.get(r.fixture) === r.fixtureHash,
  );
  console.log(`\n${formatAggregateTable(aggregateBench(all))}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
