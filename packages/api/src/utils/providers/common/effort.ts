import { getLogger } from "@logtape/logtape";

import { openaiModelMaxEffort } from "./model-cost";

const logger = getLogger(["qgrid", "effort"]);

/**
 * provider 별 reasoning effort 어휘.
 *
 * SDK 가 보낸 effort 문자열을 그대로 provider 에 넘기지 않는다. provider 마다 받는 값이 다르고,
 * 모르는 값을 받았을 때의 반응도 다르다(Codex 백엔드는 400 이 예상되고, Claude Code 는 경고만
 * 남기고 모델 기본 effort 로 실행한다). 각 provider dispatcher 가 요청을 만들 때 여기서 판정해,
 * 맞지 않는 값은 오류 없이 버리고 "미지정" 과 같게 취급한다.
 */

// Codex 구독 백엔드 모델 카탈로그(~/.codex/models_cache.json) 의 supported_reasoning_levels 합집합.
// 공개 OpenAI API 의 `none`/`minimal` 은 이 경로에 없다. 모델별 상한은 model-cost.ts 의 카탈로그에 있다.
export const OPENAI_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type OpenAIEffort = (typeof OPENAI_EFFORTS)[number];

// Claude Code `--effort` 허용값. 모델별 상한(xhigh_effort / max_effort capability)은 Claude Code 가
// 스스로 처리하므로 qgrid 는 provider 집합만 검사한다.
export const ANTHROPIC_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AnthropicEffort = (typeof ANTHROPIC_EFFORTS)[number];

// 어휘 안에 있고 상한(있다면) 이하인 값만 통과시킨다. 나머지는 debug 로그 후 미지정.
function resolveWithin<T extends string>(
  levels: readonly T[],
  effort: string | undefined,
  max: T | undefined,
  target: string,
): T | undefined {
  if (effort === undefined) return undefined;
  const rank = levels.indexOf(effort as T);
  if (rank < 0) {
    logger.debug(`ignoring effort "${effort}" for ${target}: not in ${levels.join("/")}`);
    return undefined;
  }
  if (max !== undefined && rank > levels.indexOf(max)) {
    logger.debug(`ignoring effort "${effort}" for ${target}: model supports up to "${max}"`);
    return undefined;
  }
  return effort as T;
}

/** canonical OpenAI model(`openai/` prefix 제거 후) 기준으로 effort 를 판정한다. */
export function resolveOpenAIEffort(model: string, effort?: string): OpenAIEffort | undefined {
  return resolveWithin(OPENAI_EFFORTS, effort, openaiModelMaxEffort(model), `openai/${model}`);
}

export function resolveAnthropicEffort(effort?: string): AnthropicEffort | undefined {
  return resolveWithin(ANTHROPIC_EFFORTS, effort, undefined, "anthropic");
}
