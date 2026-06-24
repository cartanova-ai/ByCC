/**
 * stream-json 어댑터 — Anthropic(Claude) provider 의 입력/출력 변환.
 *
 * 이 모듈은 부활의 유일한 본질적 신규 코드다. 두 방향을 분리된 순수 함수로 둔다:
 *  - 입력: 서버 GenerateRequest payload(coldInput/coldHistory/reuseInput)
 *          → `claude -p --input-format stream-json` 의 JSONL 라인.
 *  - 출력: `claude -p --output-format stream-json --verbose` 의 JSONL 라인
 *          → qgrid 서버 delta(onDelta) + 최종 result. (U3, 같은 파일 하단)
 *
 * 중요한 계약:
 *  - 입력은 AI SDK LanguageModelV3Message[] 가 아니라 **서버측 GenerateRequest** 다.
 *    ai-sdk 가 이미 QueryInput.history(JsonValue[]) 로 변환했고, decideConvRouting 이
 *    coldInput/coldHistory/reuseInput 으로 만든 뒤 dispatcher 에 도달한다.
 *  - content 는 user/assistant 모두 block 배열 `[{type:"text",text}]` 로 정규화한다.
 *    문자열 content 는 일부 user 단발만 통과하고 history replay 에서 깨진다
 *    (`W is not an Object (evaluating '"tool_use_id" in W')`).
 *  - stream-json 의 user/assistant 는 비대칭이다: assistant 는 history context 로 push 되고
 *    **user 는 새 prompt 로 enqueue(=실행)된다.** 따라서 cold 경로에서 과거 대화(user/assistant/
 *    tool)를 그대로 줄로 늘어놓으면 과거 user/tool-output 이 실행 prompt 로 재실행된다. 이를 피하려
 *    cold history 는 **단일 assistant context 텍스트로 평탄화**하고, 실행 가능한 `type:"user"` 줄은
 *    **마지막 input 하나뿐**이 되도록 한다. full-fidelity role replay 가 필요하면 session resume
 *    (reuseInput) 또는 JSONL backstop 으로 간다.
 *  - tool 결과는 native Anthropic tool_result 블록을 새로 만들지 않고, 기존 OpenAI 와
 *    동일하게 평탄화된 text 로 처리한다(emulation 공통 계약).
 */

import { type JsonValue } from "../../../codex-protocol/serde_json/JsonValue";
import { type UserInput } from "../../../codex-protocol/v2/UserInput";
import { type ProviderTokenUsageBreakdown } from "../common/provider-dispatcher";

// ── 입력 어댑터 ────────────────────────────────────────────────────

// Claude stream-json 입력 한 줄(JSONL). content 는 항상 block 배열.
//
// SDK envelope 필드(uuid / session_id / parent_tool_use_id)는 **여기서 만들지 않는다**.
// 그 값들은 세션을 발급/소유하는 claude-session 의 책임이다. 이 모듈은 role/content 변환만 하는
// 순수 함수로 두고, claude-session 이 직렬화 직전에 envelope 를 decorate 한다. 책임 분리.
export interface ClaudeStreamJsonLine {
  type: "user" | "assistant";
  message: {
    role: "user" | "assistant";
    content: Array<{ type: "text"; text: string }>;
  };
}

// UserInput[] 에서 text 만 뽑아 하나의 문자열로. (image/skill/mention 등은 현재 범위 밖 — text 위주)
function userInputToText(input: Array<UserInput>): string {
  return input
    .filter((i): i is Extract<UserInput, { type: "text" }> => i.type === "text")
    .map((i) => i.text)
    .join("\n");
}

// content 를 항상 block 배열로 정규화(문자열 content 는 history replay 에서 깨짐).
function textBlock(text: string): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text }];
}

// codex ResponseItem(coldHistory 의 한 항목) 형태 판별용 최소 shape.
// extractPromptAndHistory(ai-sdk/utils.ts) 가 만드는 형식:
//   { type:"message", role:"user", content:[{type:"input_text", text}] }
//   { type:"message", role:"assistant", content:[{type:"output_text", text}] }
//   { type:"function_call", name, arguments, call_id }
//   { type:"function_call_output", call_id, output }
type ResponseItem = { [key: string]: JsonValue | undefined };

function asObject(v: JsonValue | undefined): ResponseItem | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as ResponseItem) : null;
}

// codex message content([{type:input_text|output_text, text}]) 에서 text 추출.
// 여러 content 블록은 줄바꿈으로 구분(token-adjacent 붙음 방지).
function responseItemText(item: ResponseItem): string {
  const content = item.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => {
      const obj = asObject(c);
      return obj && typeof obj.text === "string" ? obj.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * cold history(codex ResponseItem[])를 **단일 평탄 텍스트**로 변환한다.
 * user/assistant/tool 모두 라벨 붙은 한 덩어리로 — 실행되지 않는 assistant context 로 들어간다.
 * (cold 의 user/tool-output 을 type:"user" 로 내보내면 새 prompt 로 재실행되므로 금지.)
 */
function flattenColdHistory(coldHistory: Array<JsonValue>): string {
  const parts: Array<string> = [];
  for (const raw of coldHistory) {
    const item = asObject(raw);
    if (!item) continue;

    if (item.type === "message" && item.role === "assistant") {
      parts.push(`Assistant: ${responseItemText(item)}`);
    } else if (item.type === "message" && item.role === "user") {
      parts.push(`User: ${responseItemText(item)}`);
    } else if (item.type === "function_call") {
      const name = typeof item.name === "string" ? item.name : "";
      const args =
        typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {});
      parts.push(`Tool call: ${name}(${args})`);
    } else if (item.type === "function_call_output") {
      const output =
        typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "");
      parts.push(`Tool result: ${output}`);
    }
  }
  return parts.join("\n");
}

/**
 * 서버 GenerateRequest payload 를 Claude stream-json JSONL 라인 배열로 변환한다.
 *
 * @param opts.coldHistory  cold 경로의 codex ResponseItem 배열(JsonValue[]). resume 경로면 미사용.
 * @param opts.input        실행할 input — cold 면 coldInput, resume 면 reuseInput.
 * @param opts.isResume     resume 경로 여부. true 면 history 재주입 없이 input(delta)만.
 *
 * 출력 규칙:
 *  - 실행 가능한 `type:"user"` 줄은 **항상 정확히 1개** — 마지막 input.
 *  - resume: user(delta) 1줄만. thread 가 이전 turn 을 누적하므로 history 미포함.
 *  - cold: coldHistory 전체를 **단일 assistant context 텍스트**로 평탄화(실행 안 됨) + user(input) 1줄.
 *          user/assistant/tool 모두 평탄화되므로 과거 user/tool-output 이 재실행되지 않는다.
 *          full-fidelity role replay 가 필요하면 session resume 또는 JSONL backstop(범위 밖).
 *  - tool(function_call/output): native 블록 없이 평탄 텍스트로.
 */
export function buildStreamJsonInput(opts: {
  coldHistory?: Array<JsonValue>;
  input: Array<UserInput>;
  isResume: boolean;
}): Array<ClaudeStreamJsonLine> {
  const lines: Array<ClaudeStreamJsonLine> = [];

  // cold 경로: history 를 단일 assistant context 로 평탄화(실행 안 됨).
  if (!opts.isResume && opts.coldHistory && opts.coldHistory.length > 0) {
    const flattened = flattenColdHistory(opts.coldHistory);
    if (flattened) {
      lines.push({
        type: "assistant",
        message: {
          role: "assistant",
          content: textBlock(`Prior conversation context:\n${flattened}`),
        },
      });
    }
  }

  // 실행할 input — resume/cold 공통, 항상 마지막의 단일 user 줄.
  lines.push({
    type: "user",
    message: { role: "user", content: textBlock(userInputToText(opts.input)) },
  });

  return lines;
}

// JSONL 문자열(claude stdin 으로 흘릴 형태)로 직렬화.
export function serializeStreamJsonInput(lines: Array<ClaudeStreamJsonLine>): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

// ── 출력 어댑터 ────────────────────────────────────────────────────
//
// claude -p --output-format stream-json --verbose 의 stdout(JSONL)을
// qgrid 서버 delta(onDelta) + 최종 result 로 변환한다.
//
// 계약:
//  - 이 어댑터는 qgrid **서버** 계층이다. AI SDK stream part(text-delta 등)는
//    packages/ai-sdk(client provider)가 만든다 — 여기서 만들지 않는다.
//  - text_delta → onDelta(text). structured output 일 때 input_json_delta.partial_json
//    조각도 onDelta(text) 로 흘린다(client provider 가 partialObjectStream 으로 누적).
//  - 최종 result → structured_output(우선) 또는 result(폴백, 자연어 가능) + usage + 종료.
//  - usage 는 input/cache_creation/cache_read/output 4 카테고리를 받아 TokenUsageBreakdown 으로.
//    payload 크기 비교는 3 카테고리 합으로(과거 학습 — input 단독 비교 무의미).

// claude stream-json 출력에서 우리가 보는 usage shape(부분). Anthropic 네이티브 필드.
interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

// 최종 result 파싱 산출물. dispatcher(U1)가 GenerateResult 조립에 쓴다.
export interface ClaudeStreamResult {
  text: string;
  usage: ProviderTokenUsageBreakdown;
  durationMs: number;
  costUsd: number;
  // quota 소진("You've hit ...") 감지. dispatcher 가 QuotaError 로 변환.
  quotaExhausted: boolean;
  // result.is_error / terminal model_error 등. dispatcher 가 에러로 변환.
  isError: boolean;
}

export interface ClaudeStreamJsonState {
  structuredOutputText?: string;
}

// Anthropic usage 4 카테고리 → TokenUsageBreakdown.
// Anthropic native usage 는 input/cache_creation/cache_read 를 서로 배타적인 카테고리로 준다.
// 반면 qgrid 내부 표준(TokenUsageBreakdown)과 cost 계산은 inputTokens 를 "전체 입력
// (= non-cache input + cache creation + cache read)" 으로 취급하고 cachedInputTokens/cacheCreationInputTokens
// 를 그중 각 몫으로 다시 표시한다(OpenAI/Codex usage 와 같은 의미). 따라서 여기서 합쳐 표준화한다.
function toUsageBreakdown(u: ClaudeUsage): ProviderTokenUsageBreakdown {
  const input = u.input_tokens ?? 0;
  const cacheCreate = u.cache_creation_input_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  const totalInput = input + cacheCreate + cacheRead;
  return {
    totalTokens: totalInput + output,
    inputTokens: totalInput,
    cachedInputTokens: cacheRead,
    cacheCreationInputTokens: cacheCreate,
    outputTokens: output,
    reasoningOutputTokens: 0,
  };
}

// result.result 의 코드펜스(```json ... ```) 제거. structured_output 이 없을 때만 쓴다.
// 앞뒤 공백/개행을 먼저 trim 해 `\n```json\n...\n```\n` 같은 형태도 깨끗이 제거.
function stripCodeFence(s: string): string {
  return s
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "");
}

function structuredOutputToolUseText(j: ResponseItem): string | undefined {
  const message = asObject(j.message);
  const content = message?.content;
  if (!Array.isArray(content)) return undefined;

  for (const raw of content) {
    const block = asObject(raw);
    if (!block) continue;
    if (
      block.type === "tool_use" &&
      block.name === "StructuredOutput" &&
      block.input !== undefined
    ) {
      return JSON.stringify(block.input);
    }
  }
  return undefined;
}

/**
 * stream-json 출력 라인 하나를 처리한다. 순수 함수 — side effect 는 onDelta 콜백뿐.
 *
 * @param opts.structuredOutput  structured output(jsonSchema) 모드 여부.
 *   structured 모드에서 Claude 는 자연어 text_delta 와 input_json_delta.partial_json 을
 *   **함께** 흘릴 수 있다(PoC 확인). 이때 text_delta 를 그대로 onDelta 로 보내면 client 의
 *   streamObject 파서가 prose 를 JSON 앞에서 만나 깨진다. 그래서:
 *     - structured 모드: text_delta 무시, partial_json 만 onDelta.
 *     - text 모드: text_delta 만 onDelta (partial_json 은 안 옴).
 *
 * @returns result 이벤트면 ClaudeStreamResult, 그 외(delta/system 등)면 null.
 *          호출부는 라인 스트림을 돌며 이 함수를 호출하고, non-null 이 나오면 종료.
 */
export function handleStreamJsonLine(
  line: string,
  onDelta: (text: string) => void,
  opts?: { structuredOutput?: boolean; state?: ClaudeStreamJsonState },
): ClaudeStreamResult | null {
  const structuredOutput = opts?.structuredOutput ?? false;
  const state = opts?.state;
  const trimmed = line.trim();
  if (!trimmed) return null;

  let j: { [key: string]: JsonValue | undefined };
  try {
    j = JSON.parse(trimmed) as { [key: string]: JsonValue | undefined };
  } catch {
    // 깨진 JSON 라인은 graceful skip.
    return null;
  }

  // 점진 delta: stream_event > content_block_delta > {text_delta | input_json_delta}.
  if (j.type === "stream_event") {
    const event = asObject(j.event);
    if (event && event.type === "content_block_delta") {
      const delta = asObject(event.delta);
      if (delta) {
        if (structuredOutput) {
          // structured: JSON 조각만. 자연어 text_delta 는 버린다(streamObject 파서 보호).
          if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
            onDelta(delta.partial_json);
          }
        } else {
          // text: 자연어 delta 만.
          if (delta.type === "text_delta" && typeof delta.text === "string") {
            onDelta(delta.text);
          }
        }
      }
    }
    return null;
  }

  if (
    j.type === "assistant" &&
    structuredOutput &&
    state &&
    state.structuredOutputText === undefined
  ) {
    const text = structuredOutputToolUseText(j);
    if (text !== undefined) state.structuredOutputText = text;
    return null;
  }

  // 최종 result.
  if (j.type === "result") {
    let text: string;
    const preservedStructuredOutput = structuredOutput ? state?.structuredOutputText : undefined;
    if (preservedStructuredOutput !== undefined) {
      text = preservedStructuredOutput;
    } else if (j.structured_output !== undefined) {
      text = JSON.stringify(j.structured_output);
    } else {
      text = stripCodeFence(typeof j.result === "string" ? j.result : "");
    }

    const usage = toUsageBreakdown((asObject(j.usage) ?? {}) as ClaudeUsage);
    const quotaExhausted = text.startsWith("You've hit");
    // 에러 판정: is_error true, terminal model_error,
    // 또는 subtype 이 있고 "success" 가 아니면(error_during_execution / error_max_turns /
    // error_max_budget_usd / error_max_structured_output_retries 등) 에러로 본다.
    const subtype = typeof j.subtype === "string" ? j.subtype : undefined;
    const isError =
      j.is_error === true ||
      j.terminal_reason === "model_error" ||
      (subtype !== undefined && subtype !== "success");

    return {
      text,
      usage,
      durationMs: typeof j.duration_ms === "number" ? j.duration_ms : 0,
      costUsd: typeof j.total_cost_usd === "number" ? j.total_cost_usd : 0,
      quotaExhausted,
      isError,
    };
  }

  return null;
}
