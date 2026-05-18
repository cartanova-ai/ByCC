import { type generateText as _aiGenerateText } from "ai";
import { z } from "zod";

import { type OutputDefinition } from "./output";
import { type QgridResponse, type QgridTypedResponse, type QgridUsage } from "./types";

type AiGenerateTextParams = Parameters<typeof _aiGenerateText>[0];
type AiGenerateTextResult = Awaited<ReturnType<typeof _aiGenerateText>>;

export type QgridModel =
  | "anthropic/claude-haiku-4.5"
  | "anthropic/claude-sonnet-4"
  | "anthropic/claude-sonnet-4.5"
  | "anthropic/claude-sonnet-4.6"
  | "anthropic/claude-sonnet-4.7"
  | "anthropic/claude-opus-4"
  | "anthropic/claude-opus-4.1"
  | "anthropic/claude-opus-4.5"
  | "anthropic/claude-opus-4.6"
  | "anthropic/claude-opus-4.7"
  | "openai/gpt-5.4"
  | "openai/gpt-5.5"
  | "openai/gpt-5.3-codex"
  | (string & {});

function toServerModel(model: QgridModel): string {
  if (model.includes("/")) return model;
  return `anthropic/${model}`;
}

export class QgridError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "QgridError";
  }
}

// CC --effort 와 동일. 답변 깊이/추론량 제어. 미지정 시 서버 기본값(high).
export type QgridEffort = "low" | "medium" | "high";

type SchemaCacheEntry = { json: string; wrapped: boolean };
const jsonSchemaCache = new WeakMap<z.ZodType, SchemaCacheEntry>();

// Anthropic structured output (`--json-schema`) 은 top-level type 이 반드시 "object" 여야 함.
// z.enum / z.array / z.string 같은 primitive/array 스키마는 거부됨 (400 invalid_request_error).
// 그래서 top-level 이 object 가 아니면 `{ result: <orig> }` 로 자동 wrap 하고,
// 응답 받을 때 `parsed.result` 만 꺼내 검증한다 (caller 입장에선 동일 동작).
function getJsonSchema(schema: z.ZodType): SchemaCacheEntry {
  let cached = jsonSchemaCache.get(schema);
  if (!cached) {
    const raw = z.toJSONSchema(schema) as Record<string, unknown>;
    // `$schema` 메타 필드는 Anthropic `--json-schema` 가 거부 → 제거
    const { $schema: _s, ...rest } = raw;
    const wrapped = rest.type !== "object";
    const finalSchema = wrapped
      ? { type: "object", properties: { result: rest }, required: ["result"] }
      : rest;
    cached = { json: JSON.stringify(finalSchema), wrapped };
    jsonSchemaCache.set(schema, cached);
  }
  return cached;
}

/**
 * 기존 qgrid 전용 API.
 * 단순한 prompt/system 기반 호출 + Zod returnType 검증.
 */
export async function queryQgrid<T extends z.ZodType | undefined = undefined>(params: {
  prompt: string;
  system?: string;
  model?: QgridModel;
  projectName?: string;
  returnType?: T;
  effort?: QgridEffort;
  abortSignal?: AbortSignal;
  serverUrl?: string;
}): Promise<T extends z.ZodType ? QgridTypedResponse<z.infer<T>> : QgridResponse> {
  const { prompt, system, model, projectName, returnType, effort } = params;
  const serverModel = model ? toServerModel(model) : undefined;
  const url = params.serverUrl ?? process.env.QGRID_URL ?? "http://localhost:44900";
  const signal = params.abortSignal ?? AbortSignal.timeout(300_000);

  // returnType 있으면 CLI 의 --json-schema 를 사용. schema 가 system prompt 에 들어가지 않고
  // Anthropic API 의 structured output (tool) 로 네이티브 전달됨 → prefix cache 절감, 파싱 실패 없음.
  const schemaEntry = returnType ? getJsonSchema(returnType) : undefined;

  const res = await fetch(`${url}/api/qgrid/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      system,
      model: serverModel,
      projectName: projectName ?? process.env.QGRID_PROJECT_NAME,
      jsonSchema: schemaEntry?.json,
      effort,
    }),
    signal,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    const message = err.error ?? err.message ?? res.statusText;
    if (res.status === 429) throw new QgridError("QUOTA_EXHAUSTED", 429, message);
    if (res.status === 503) throw new QgridError("SERVER_UNAVAILABLE", 503, message);
    throw new QgridError("REQUEST_FAILED", res.status, message);
  }

  const { text, ...rest } = await res.json();
  if (!returnType || !schemaEntry) {
    return { ...rest, data: text };
  }

  // structured output 은 서버가 이미 JSON 문자열로 직렬화해서 넘겨줌. 파싱 + zod 검증만.
  // wrap 된 경우 (top-level 이 object 가 아니었던 schema) 는 `result` 필드만 꺼내 검증.
  try {
    const parsed = JSON.parse(text);
    const unwrapped = schemaEntry.wrapped ? parsed.result : parsed;
    return { ...rest, data: z.parse(returnType, unwrapped) };
  } catch (e) {
    throw new QgridError(
      "PARSE_FAILED",
      200,
      `structured output 파싱/검증 실패: ${(e as Error).message}`,
    );
  }
}

// --- ai-sdk 호환 API (single-turn 전용) ---

function mapUsage(usage: QgridUsage): AiGenerateTextResult["usage"] {
  return {
    inputTokens: usage.input_tokens,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: usage.cache_read_input_tokens,
      cacheWriteTokens: usage.cache_creation_input_tokens,
    },
    outputTokens: usage.output_tokens,
    outputTokenDetails: {
      textTokens: usage.output_tokens,
      reasoningTokens: undefined,
    },
    totalTokens: usage.input_tokens + usage.output_tokens,
  };
}

function extractSchema(output: unknown): z.ZodType | undefined {
  if (!output || typeof output !== "object") return undefined;
  if (!("type" in output) || !("schema" in output)) return undefined;
  const def = output as OutputDefinition<unknown>;
  if (def.type === "text" || !def.schema) return undefined;
  return def.schema;
}

type BaseParams = Omit<
  AiGenerateTextParams,
  "model" | "messages" | "prompt" | "output" | "experimental_output"
> & {
  prompt: string;
  system?: string;
  model?: QgridModel;
  projectName?: string;
  effort?: QgridEffort;
  serverUrl?: string;
};

type GenerateTextResponse<T> = {
  text: string;
  usage: AiGenerateTextResult["usage"];
  finishReason: AiGenerateTextResult["finishReason"];
  output: T;
};

// OutputDefinition → T 추론
export async function generateText<T>(
  params: BaseParams & { output: OutputDefinition<T> },
): Promise<GenerateTextResponse<T>>;

// output 없음 → string
export async function generateText(params: BaseParams): Promise<GenerateTextResponse<string>>;

// implementation
export async function generateText(
  params: BaseParams & { output?: OutputDefinition<any> },
): Promise<GenerateTextResponse<any>> {
  const { prompt, system } = params;
  const schema = extractSchema(params.output);
  const rest = {
    model: params.model,
    projectName: params.projectName,
    effort: params.effort,
    serverUrl: params.serverUrl,
    abortSignal: params.abortSignal,
  };

  if (schema) {
    const result = await queryQgrid({ prompt, system, returnType: schema, ...rest });
    return {
      text: JSON.stringify(result.data),
      usage: mapUsage(result.usage),
      finishReason: "stop",
      output: result.data,
    };
  }

  const result = await queryQgrid({ prompt, system, ...rest });
  return {
    text: result.data,
    usage: mapUsage(result.usage),
    finishReason: "stop",
    output: result.data,
  };
}

export { Output } from "./output";
export type { OutputDefinition } from "./output";
export type { QgridBase, QgridResponse, QgridTypedResponse, QgridUsage } from "./types";
export type { FinishReason, GenerateTextResult, LanguageModelUsage } from "ai";
