/**
 * conv-routing — conversation(=codex thread) 재사용을 위한 thread 좌표 검증/구성.
 *
 * 목표: thread(=conversation_id=prompt_cache_key)를 재사용해 OpenAI prompt caching 적중.
 * - 후속 turn: 기존 thread 에 delta(마지막 user / tool 결과)만 보냄 (history inject 없음).
 * - 첫 turn / 검증 실패: 새 thread + history inject (폴백, 정확성 보존).
 *
 * 식별: 서버 발급 불투명 thread 좌표(QgridThreadCoord)를 클라가 그대로 회송.
 * 검증: systemHash(다른 대화 오접속 차단) + (dispatcher의) epoch/worker 생존.
 */
import { createHash, randomBytes } from "node:crypto";

import { type ReuseThreadCoord } from "../../utils/providers/common/provider-dispatcher";
import { type JsonValue, type UserInput } from "../../utils/providers/common/provider-types";
import { type QgridThreadCoord, type QueryInput, type QgridToolResultInput } from "./qgrid.types";

export function systemHash(system?: string, modelNamespace?: string): string {
  return createHash("sha256")
    .update(modelNamespace === undefined ? (system ?? "") : `${modelNamespace}\0${system ?? ""}`)
    .digest("hex")
    .slice(0, 16);
}

// tool 결과를 다음 turn 의 input text 로 변환 (codex turn/start.input 은 UserInput 만 받음).
function toolResultsToText(toolResults: QgridToolResultInput[]): string {
  const lines = toolResults.map((tr) => {
    const name = tr.toolName ? ` (${tr.toolName})` : "";
    const errMark = tr.isError ? " [error]" : "";
    return `Tool result for call ${tr.toolCallId}${name}${errMark}: ${tr.output}`;
  });
  return `${lines.join("\n")}\n\nNow continue answering the user's request using these results.`;
}

export interface ConvDecision {
  // dispatcher 로 넘길 reuse 좌표 (검증 통과 시에만). dispatcher 가 epoch/worker 생존 재검증 후 폴백 가능.
  reuse?: ReuseThreadCoord;
  // 재사용 성공 시 turn/start 에 보낼 input — delta(마지막 user/tool 결과)만. reuse 가 있을 때만 설정.
  reuseInput?: Array<UserInput>;
  // 첫 turn / 재사용 폴백 시 보낼 input — 전체 prompt. 항상 설정(폴백 안전망).
  coldInput: Array<UserInput>;
  // 새 thread 일 때 inject 할 전체 history. 재사용 성공 시엔 dispatcher 가 안 쓴다(thread 가 이미 누적).
  coldHistory?: Array<JsonValue>;
  // 이 요청 시점의 system 해시 (응답에서 thread 좌표 발급 시 사용).
  systemHash: string;
  // Direct-provider cache affinity. Presence marks the epoch=-1 coordinate semantics.
  promptCacheKey?: string;
  preferredTokenId?: number;
}

export interface ConvRoutingOptions {
  directOpenAI?: boolean;
  modelNamespace?: string;
}

// thread 좌표 + 들어온 요청으로 "재사용 가능한가"를 판정하고, reuse/cold 양쪽 payload 를 구성한다.
// dispatcher 단의 epoch/worker 생존 검증은 여기서 못 하므로(상태 없음) reuse 좌표 + 두 payload 를
// 모두 넘기고, dispatcher 의 acquireReuseWorker 결과에 따라 reuse(delta) 또는 cold(전체) 를 고른다.
// 양쪽을 다 들고 가야 reuse 가 실패로 폴백돼도 전체 history 로 문맥을 복구할 수 있다.
export function decideConvRouting(
  input: QueryInput,
  options: ConvRoutingOptions = {},
): ConvDecision {
  const sysHash = systemHash(
    input.system,
    options.directOpenAI ? (options.modelNamespace ?? input.model ?? "openai") : undefined,
  );
  const history: Array<JsonValue> | undefined = input.history
    ? (JSON.parse(input.history) as Array<JsonValue>)
    : undefined;

  const coord = input.runContext?.threadCoord;

  // 재사용 자격: 좌표 존재 + system 동일. sessionKey 격리 + systemHash 로 대화 동일성이
  // 보장되고, 공통 prefix 는 codex 가 prompt_cache_key 고정으로 알아서 캐시한다.
  const directCoordEligible =
    options.directOpenAI === true &&
    coord?.epoch === -1 &&
    coord.systemHash === sysHash &&
    input.cacheAffinityKey !== undefined &&
    coord.threadId === input.cacheAffinityKey;
  const legacyReuseEligible =
    options.directOpenAI !== true && coord !== undefined && coord.systemHash === sysHash;
  const cacheKey = options.directOpenAI
    ? (input.cacheAffinityKey ??
      (directCoordEligible ? coord.threadId : randomBytes(32).toString("hex")))
    : undefined;

  return {
    reuse:
      legacyReuseEligible && coord
        ? { workerId: coord.workerId, threadId: coord.threadId, epoch: coord.epoch }
        : undefined,
    // 재사용 turn 은 delta(마지막 user/tool 결과)만 — thread 가 이미 이전 turn 들을 누적.
    reuseInput: legacyReuseEligible ? buildDeltaInput(input) : undefined,
    // 첫 turn / 폴백: 전체 prompt + history inject. tool 결과 follow-up 이 cold 로 떨어져도
    // 실행 user 줄에는 "이 결과로 계속 답하라"는 continuation 이 들어가야 한다.
    coldInput: buildDeltaInput(input),
    coldHistory: history,
    systemHash: sysHash,
    promptCacheKey: cacheKey,
    preferredTokenId: directCoordEligible ? coord.workerId : undefined,
  };
}

// 후속 turn 의 input: tool 결과가 있으면 그걸 text 로, 없으면 마지막 user(prompt).
function buildDeltaInput(input: QueryInput): Array<UserInput> {
  if (input.toolResults && input.toolResults.length > 0) {
    return [{ type: "text", text: toolResultsToText(input.toolResults), text_elements: [] }];
  }
  if (input.input && input.input.length > 0) {
    const hasText = input.input.some((part) => part.type === "text");
    const parts: Array<UserInput> = input.input.map((part) => {
      if (part.type === "text") {
        return { type: "text", text: part.text, text_elements: part.text_elements };
      }
      return { type: "image", url: part.url };
    });
    if (!hasText && input.prompt.length > 0) {
      return [{ type: "text", text: input.prompt, text_elements: [] }, ...parts];
    }
    return parts;
  }
  return [{ type: "text", text: input.prompt, text_elements: [] }];
}

// 응답 threadCoord + 요청 시점 정보로 다음 thread 좌표를 발급한다.
export function issueConvContext(
  threadCoord: ReuseThreadCoord,
  decision: ConvDecision,
  preferredTokenId = threadCoord.workerId,
): QgridThreadCoord {
  if (decision.promptCacheKey) {
    return {
      workerId: preferredTokenId,
      threadId: decision.promptCacheKey,
      epoch: -1,
      systemHash: decision.systemHash,
    };
  }
  return {
    workerId: threadCoord.workerId,
    threadId: threadCoord.threadId,
    epoch: threadCoord.epoch,
    systemHash: decision.systemHash,
  };
}
