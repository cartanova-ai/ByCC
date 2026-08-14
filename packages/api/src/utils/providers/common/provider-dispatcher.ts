/**
 * ProviderDispatcher — provider 별 LLM 요청 실행 인터페이스.
 *
 * MVP 에서는 stream() 만. getRateLimits(), listModels() 는 future.
 */

import { type ImageGenerationOptions } from "../../../application/qgrid/qgrid.types";
import { type JsonValue, type TokenUsageBreakdown, type UserInput } from "./provider-types";

// qgrid provider 내부 표준 usage. provider 전용 cache write 세부 필드는 여기서 확장해 보존한다.
export type ProviderTokenUsageBreakdown = TokenUsageBreakdown & {
  cacheCreationInputTokens?: number;
  cacheCreationInputTokens5m?: number;
  cacheCreationInputTokens1h?: number;
};

// thread 재사용 라우팅 좌표. 상위(qgrid.dispatcher)에서 conv 핸들 검증을 통과한 경우에만 전달.
// dispatcher 는 이 좌표가 가리키는 worker 의 기존 thread 에 turn 만 실행한다.
export interface ReuseThreadCoord {
  workerId: number;
  threadId: string;
  epoch: number;
}

// provider-무관 이미지 결과. OpenAI 경로에서만 채워지며, 상위(qgrid.dispatcher)가
// content 파트로 전파한다. Anthropic 경로는 이 필드를 채우지 않는다.
export interface GeneratedImage {
  data: string; // base64 PNG
  revisedPrompt: string | null;
}

// Provider/런타임이 요청 모델 대신 다른 모델로 실제 응답을 생성한 이력.
// 현재 Claude Code 의 Fable refusal → Opus 안전 fallback 을 표현하며, 향후 provider
// fallback 도 같은 계약으로 올릴 수 있다.
export interface ModelFallback {
  trigger: "refusal";
  fromModel: string;
  toModel: string;
  category?: string;
  explanation?: string;
}

export type CostSource = "provider" | "pricing_table" | "mixed";

export interface GenerateRequest {
  // 미지정이면 dispatcher 가 provider 별 default 를 적용한다(Anthropic: ANTHROPIC_DEFAULT_MODEL).
  // OpenAI 경로는 항상 prefix split 후 canonical model 을 넘기므로 영향 없음.
  model?: string;
  systemPrompt?: string;
  outputSchema?: JsonValue;
  effort?: string;
  verbosity?: string;
  reasoningSummary?: string;
  serviceTier?: string;
  // provider 실행 제한(ms). Queue selection 이후의 active provider request 전체에 적용한다.
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  // 첫 turn / 재사용 폴백 시 보낼 input — 전체 prompt. 항상 설정.
  coldInput: Array<UserInput>;
  // 첫 turn / 폴백 시 inject 할 전체 history.
  coldHistory?: Array<JsonValue>;
  // Provider-neutral cache affinity hints. Direct OpenAI currently receives these while still
  // replaying coldInput + coldHistory on every turn; a dispatcher may use them for token choice
  // and prompt-cache routing without relying on a process-local worker/thread.
  promptCacheKey?: string;
  preferredTokenId?: number;
  // 재사용 좌표 + delta input. 둘은 한 쌍 — 검증 통과 시에만 설정한다.
  // dispatcher 가 worker/thread 생존을 재검증해 성공하면 reuseInput(delta)을, 실패하면
  // coldInput + coldHistory 로 폴백한다(전체 history 로 문맥 복구).
  reuse?: ReuseThreadCoord;
  reuseInput?: Array<UserInput>;
  // OpenAI image_generation tool 을 켠다(OpenAI 경로 전용, opt-in).
  // 이 플래그가 있으면 dispatcher 는 항상 cold thread 로 실행하고 재사용 라우팅을 건너뛴다.
  imageGeneration?: boolean;
  imageGenerationOptions?: ImageGenerationOptions;
}

export interface GenerateResult {
  text: string;
  tokenName: string;
  usage: ProviderTokenUsageBreakdown;
  durationMs: number;
  ttftMs?: number | null;
  // Provider 가 직접 산출한 비용. Anthropic Claude Code 는 total_cost_usd 를 주므로 이 값을
  // 우선 사용하고, 없으면 상위가 모델별 가격표로 계산한다.
  costUsd?: number;
  // model 은 실제 응답을 생성한 serving model. fallback 이 없으면 requestedModel 과 같다.
  model: string;
  requestedModel?: string;
  modelFallbacks?: Array<ModelFallback>;
  // 이번 turn 이 사용한 thread 좌표. 상위가 conv 핸들을 발급/갱신하는 데 쓴다.
  threadCoord: ReuseThreadCoord;
  // 이미지 turn 에서만 채워짐(OpenAI 경로). 완성 이미지가 없으면 undefined.
  images?: GeneratedImage[];
}

// 스트림 콜백 컨테이너. 계층별로 onComplete payload 만 다르고, 스트림 이벤트 shape 는 동일하다.
export interface StreamCallbacks<TComplete> {
  onDelta: (text: string) => void;
  onComplete: (result: TComplete) => void;
  onError: (error: Error) => void;
  onThreadId?: (threadId: string) => void;
  onTurnId?: (turnId: string) => void;
}

// 상위(qgrid.dispatcher)로 가는 스트림 콜백. onComplete 는 non-stream 의 GenerateResult 와
// 동일 shape(tokenName/threadCoord 포함)를 받아, 두 경로가 같은 일급 타입을 공유한다.
export type GenerateStreamCallbacks = StreamCallbacks<GenerateResult>;

export interface ProviderDispatcher {
  generate(req: GenerateRequest): Promise<GenerateResult>;
  start(): Promise<void>;
  stop(): Promise<void>;
}
