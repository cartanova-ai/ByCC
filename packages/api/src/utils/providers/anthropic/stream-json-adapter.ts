/**
 * Claude CLI stream-json adapter.
 *
 * Input: qgrid history/input -> Claude JSONL stdin.
 * Output: Claude JSONL stdout -> qgrid deltas + final result metadata.
 *
 * Previous conversation items are flattened into one assistant context line.
 * The only executable user line is the current input.
 */

import { type JsonValue } from "../../../codex-protocol/serde_json/JsonValue";
import { type UserInput } from "../../../codex-protocol/v2/UserInput";
import { type ProviderTokenUsageBreakdown } from "../common/provider-dispatcher";

// ── 입력 어댑터 ────────────────────────────────────────────────────

// Claude stream-json 입력 한 줄(JSONL). Envelope fields are added in claude-session.
export interface ClaudeStreamJsonLine {
  type: "user" | "assistant";
  message: {
    role: "user" | "assistant";
    content: Array<{ type: "text"; text: string }>;
  };
}

function userInputToText(input: Array<UserInput>): string {
  return input
    .filter((i): i is Extract<UserInput, { type: "text" }> => i.type === "text")
    .map((i) => i.text)
    .join("\n");
}

function textBlock(text: string): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text }];
}

// codex ResponseItem(coldHistory item) 최소 shape.
// extractPromptAndHistory(ai-sdk/utils.ts) 가 만드는 형식:
//   { type:"message", role:"user", content:[{type:"input_text", text}] }
//   { type:"message", role:"assistant", content:[{type:"output_text", text}] }
//   { type:"function_call", name, arguments, call_id }
//   { type:"function_call_output", call_id, output }
type ResponseItem = { [key: string]: JsonValue | undefined };

function asObject(v: JsonValue | undefined): ResponseItem | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as ResponseItem) : null;
}

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

export function buildStreamJsonInput(opts: {
  coldHistory?: Array<JsonValue>;
  input: Array<UserInput>;
}): Array<ClaudeStreamJsonLine> {
  const lines: Array<ClaudeStreamJsonLine> = [];

  if (opts.coldHistory && opts.coldHistory.length > 0) {
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

  lines.push({
    type: "user",
    message: { role: "user", content: textBlock(userInputToText(opts.input)) },
  });

  return lines;
}

export function serializeStreamJsonInput(lines: Array<ClaudeStreamJsonLine>): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

// ── 출력 어댑터 ────────────────────────────────────────────────────
//
// Claude stdout(JSONL)을 qgrid deltas + final result 로 변환한다.

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface ClaudeStreamResult {
  text: string;
  usage: ProviderTokenUsageBreakdown;
  durationMs: number;
  costUsd: number;
  // quota 소진("You've hit ...") 감지. dispatcher 가 QuotaError 로 변환.
  quotaExhausted: boolean;
  // result.is_error / terminal model_error 등. dispatcher 가 에러로 변환.
  isError: boolean;
  // 진단용: CC result 라인의 subtype("success" | "error_max_turns" | ...) 과 terminal_reason.
  // isError 판정 사유를 에러 메시지에 드러내기 위해 보존한다(SON-495).
  subtype?: string;
  terminalReason?: string;
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

// Processes one Claude stdout JSONL line. Returns final result on result event.
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
    return null;
  }

  if (j.type === "stream_event") {
    const event = asObject(j.event);
    if (event && event.type === "content_block_delta") {
      const delta = asObject(event.delta);
      if (delta) {
        if (structuredOutput) {
          if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
            onDelta(delta.partial_json);
          }
        } else {
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
    const subtype = typeof j.subtype === "string" ? j.subtype : undefined;
    const terminalReason = typeof j.terminal_reason === "string" ? j.terminal_reason : undefined;

    // SON-495: 비정상 종료(error_max_structured_output_retries 등)는 정직하게 에러로 처리한다.
    // CC structured output 은 constrained decoding 이 아니라 "tool input 생성 후 사후 AJV 검증"이라
    // 모델이 가끔 placeholder($PARAMETER_NAME)·거부("just kidding")·필드 누락(advance) 같은 발작/
    // 불완전 출력을 낸다. 이를 "거의 맞았으니 살리자"고 흘리면 클라이언트 검증에서 깨지거나(필드 누락)
    // 쓰레기가 새어 나간다(실측 11674/11675). 알려진 best practice(refusal/degenerate output 은 살리지
    // 말고 graceful error)대로, subtype != success 는 그대로 에러로 둔다. 클라이언트가 그 턴을 실패로
    // 다루게 한다(스트림이라 자동 재시도 없음 — 시간 2배 방지).
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
      subtype,
      terminalReason,
    };
  }

  return null;
}
