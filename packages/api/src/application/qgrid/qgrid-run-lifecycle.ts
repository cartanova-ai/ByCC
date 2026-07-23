import { getLogger } from "@logtape/logtape";

import { RequestLogModel } from "../request-log/request-log.model";
import {
  estimateImageGenerationCostMicroUsd,
  imageGenerationCostMethod,
} from "./qgrid-image-generation";
import {
  buildImageGenerationToolSteps,
  formatResponseForLog,
  getImageParts,
} from "./qgrid-response-format";
import { type QgridRunContext, type QueryInput, type QueryOutput } from "./qgrid.types";

const logger = getLogger(["qgrid", "run-lifecycle"]);
const STALE_RUN_THRESHOLD_MS = 30 * 60 * 1000;
const STALE_CLEANUP_INTERVAL_MS = 60 * 1000;
let staleCleanupInFlight: Promise<void> | undefined;
let lastStaleCleanupStartedAt = 0;

function withProviderPrefix(
  routeModel: string | undefined,
  model: string | undefined,
): string | undefined {
  if (!model) return undefined;
  if (model.includes("/")) return model;
  const slash = routeModel?.indexOf("/") ?? -1;
  const provider = slash > 0 ? routeModel?.slice(0, slash) : undefined;
  return provider ? `${provider}/${model}` : model;
}

/**
 * history는 원본 그대로 저장하기보다는, run 분석에 필요한 user/assistant 정보만 필터링해서 저장
 */
function filterHistoryForStorage(rawHistory: string | undefined): unknown {
  if (!rawHistory) return undefined;
  try {
    const items = JSON.parse(rawHistory) as unknown[];
    const filtered = items.filter((item) => {
      if (!item || typeof item !== "object") return false;
      const record = item as Record<string, unknown>;
      return record.type === "message" && (record.role === "user" || record.role === "assistant");
    });
    return filtered.length > 0 ? filtered : undefined;
  } catch {
    return undefined;
  }
}

export type RunLifecycleResult = {
  runContext?: QgridRunContext;
};

/**
 * logger-enabled query/stream 응답 전후에 호출.
 *
 * 1) beforeQuery: run 생성/계속 + tool result 완료 + stale tool-wait cleanup
 * 2) afterQuery: generate step + tool-call step + finish/keep-open
 */
export async function beforeQuery(args: QueryInput): Promise<{
  requestLogId: number;
  stepIndex: number;
}> {
  let requestLogId: number;
  let stepIndex = 0;

  // requestLogId 가 있을 때만 기존 run 연장. threadCoord 만 있는 conv 는 새 run 으로 시작.
  if (args.runContext?.requestLogId !== undefined) {
    requestLogId = args.runContext.requestLogId;
    // cleanup과 같은 DB advisory lock을 잡고 tool 결과 반영 + 다음 step 예약을 한
    // transaction에서 처리한다. 여러 qgrid 프로세스 사이에서도 stale expiry가
    // 도착 중인 follow-up을 error로 덮어쓰지 못한다.
    stepIndex = await RequestLogModel.continueToolRun(requestLogId, args.toolResults ?? []);
    await cleanupStaleRuns();
  } else {
    await cleanupStaleRuns();
    requestLogId = await RequestLogModel.createRun({
      user_prompt: args.prompt,
      system_prompt: args.system,
      requested_model_name: args.model,
      effort: args.effort,
      project_name: args.projectName,
      history: filterHistoryForStorage(args.history),
      is_image_generation: args.imageGeneration,
    });
  }

  return { requestLogId, stepIndex };
}

export async function afterQuery(
  requestLogId: number,
  stepIndex: number,
  args: QueryInput,
  result: QueryOutput,
): Promise<RunLifecycleResult> {
  // provider가 canonical model을 돌려줘도 요청 route 자체([1m] 등)는 보존한다.
  const requestedModelName = withProviderPrefix(
    args.model,
    args.model ?? result.requestedModel ?? result.model,
  );
  const servedModelName = withProviderPrefix(args.model, result.model);

  // generate step 기록
  await RequestLogModel.appendStep(requestLogId, {
    step_index: stepIndex,
    type: "generate",
    model_name: servedModelName,
    requested_model_name: requestedModelName,
    fallback_count: result.modelFallbacks?.length ?? 0,
    input_tokens: result.usage.input_tokens,
    output_tokens: result.usage.output_tokens,
    cache_read_tokens: result.usage.cache_read_input_tokens,
    cache_creation_tokens: result.usage.cache_creation_input_tokens,
    cache_creation_5m_tokens: result.usage.cache_creation_5m_input_tokens,
    cache_creation_1h_tokens: result.usage.cache_creation_1h_input_tokens,
    cost_usd: Math.round(result.costUsd * 1_000_000),
    cost_source: result.costSource,
    duration_ms: result.durationMs,
    ttft_ms: result.ttftMs,
    finish_reason: result.finishReason,
  });

  const imageParts = getImageParts(result);
  const imageCostMicroUsd = estimateImageGenerationCostMicroUsd(
    result,
    args.imageGenerationOptions,
  );
  for (const step of buildImageGenerationToolSteps(args, imageParts, stepIndex)) {
    await RequestLogModel.appendStep(requestLogId, step);
  }

  if (result.finishReason === "tool-calls") {
    // tool-call step을 즉시 기록하고, 다음 follow-up이 같은 row에 결과를 채운다.
    const toolCalls = result.content.filter((c) => c.type === "tool-call");
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i]!;
      if (tc.type !== "tool-call") continue;
      await RequestLogModel.appendStep(requestLogId, {
        step_index: stepIndex,
        type: "tool_call",
        tool_call_index: imageParts.length + i,
        tool_call_id: tc.toolCallId,
        tool_name: tc.toolName,
        tool_args: tc.input,
      });
    }

    return { runContext: { requestLogId } };
  }

  // finishReason === "stop" → run 종료 (전체 step usage 합산)
  const agg = await RequestLogModel.aggregateStepUsage(requestLogId);
  await RequestLogModel.finishRun(requestLogId, {
    status: "succeeded",
    response: formatResponseForLog(result),
    token_name: result.tokenName,
    input_tokens: agg.input_tokens,
    output_tokens: agg.output_tokens,
    cache_read_tokens: agg.cache_read_tokens,
    cache_creation_tokens: agg.cache_creation_tokens,
    cache_creation_5m_tokens: agg.cache_creation_5m_tokens,
    cache_creation_1h_tokens: agg.cache_creation_1h_tokens,
    duration_ms: agg.duration_ms,
    // multi-step run 부모의 모델은 최종 turn을 서빙한 모델이다.
    requested_model_name: requestedModelName,
    model_name: servedModelName,
    fallback_count: agg.fallback_count,
    cost_usd: agg.cost_usd,
    cost_source: agg.cost_source,
    image_cost_usd: imageCostMicroUsd,
    image_cost_method:
      imageCostMicroUsd !== null ? imageGenerationCostMethod(args.imageGenerationOptions) : null,
    history: filterHistoryForStorage(args.history),
  });

  return {};
}

export async function finishRunWithError(
  requestLogId: number,
  errorMessage: string,
  args?: QueryInput,
): Promise<void> {
  await finishTerminalRun(requestLogId, "error", errorMessage, args);
}

export async function finishRunAborted(requestLogId: number, args?: QueryInput): Promise<void> {
  await finishTerminalRun(requestLogId, "aborted", "client disconnected", args);
}

async function finishTerminalRun(
  requestLogId: number,
  status: "error" | "aborted",
  errorMessage: string,
  args?: QueryInput,
): Promise<void> {
  try {
    let aggregate: Awaited<ReturnType<typeof RequestLogModel.aggregateStepUsage>> | undefined;
    try {
      aggregate = await RequestLogModel.aggregateStepUsage(requestLogId);
    } catch (e) {
      logger.error(`aggregateStepUsage failed while finishing ${status}: ${(e as Error).message}`);
    }

    await RequestLogModel.finishRun(requestLogId, {
      status,
      error_message: errorMessage,
      history: args ? filterHistoryForStorage(args.history) : undefined,
      ...(aggregate
        ? {
            input_tokens: aggregate.input_tokens,
            output_tokens: aggregate.output_tokens,
            cache_read_tokens: aggregate.cache_read_tokens,
            cache_creation_tokens: aggregate.cache_creation_tokens,
            cache_creation_5m_tokens: aggregate.cache_creation_5m_tokens,
            cache_creation_1h_tokens: aggregate.cache_creation_1h_tokens,
            duration_ms: aggregate.duration_ms,
            fallback_count: aggregate.fallback_count,
            cost_usd: aggregate.cost_usd,
            cost_source: aggregate.cost_source,
          }
        : {}),
    });
  } catch (e) {
    logger.error(`finishTerminalRun(${status}) failed: ${(e as Error).message}`);
  }
}

async function cleanupStaleRuns(): Promise<void> {
  if (staleCleanupInFlight) {
    await staleCleanupInFlight;
    return;
  }

  const now = Date.now();
  if (now - lastStaleCleanupStartedAt < STALE_CLEANUP_INTERVAL_MS) return;
  lastStaleCleanupStartedAt = now;

  const cleanup = performStaleRunCleanup();
  staleCleanupInFlight = cleanup;
  try {
    await cleanup;
  } finally {
    if (staleCleanupInFlight === cleanup) staleCleanupInFlight = undefined;
  }
}

async function performStaleRunCleanup(): Promise<void> {
  try {
    const errorMessage = "tool-call run: no follow-up within 30 minutes";
    const staleIds = await RequestLogModel.expireStaleToolWaitingRuns(
      STALE_RUN_THRESHOLD_MS,
      errorMessage,
    );
    const cleanedCount = staleIds.length;
    if (cleanedCount > 0) {
      logger.info(`cleaned up ${cleanedCount} stale running request logs`);
    }
  } catch (e) {
    logger.error(`stale cleanup failed: ${(e as Error).message}`);
  }
}
