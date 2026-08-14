import { getLogger } from "@logtape/logtape";
import { ServiceUnavailableException } from "sonamu";

import { SD } from "../../i18n/sd.generated";
import { isRestartPending } from "../../utils/server-restart";
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
const activeNativeRunRefs = new Map<number, number>();
const interruptedNativeRunIds = new Set<number>();
const activeNativeFinalizers = new Map<number, Set<Promise<void>>>();

function restartUnavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException(SD("qgrid.restartPending")());
}

function registerNativeRun(requestLogId: number): void {
  activeNativeRunRefs.set(requestLogId, (activeNativeRunRefs.get(requestLogId) ?? 0) + 1);
}

function releaseNativeRun(requestLogId: number): void {
  const refs = activeNativeRunRefs.get(requestLogId);
  if (refs === undefined || refs <= 1) activeNativeRunRefs.delete(requestLogId);
  else activeNativeRunRefs.set(requestLogId, refs - 1);
}

function trackNativeFinalizer<T>(requestLogId: number, finalize: () => Promise<T>): Promise<T> {
  const operation = finalize();
  const settled = operation.then(
    () => undefined,
    () => undefined,
  );
  const finalizers = activeNativeFinalizers.get(requestLogId) ?? new Set<Promise<void>>();
  finalizers.add(settled);
  activeNativeFinalizers.set(requestLogId, finalizers);
  void settled.then(() => {
    finalizers.delete(settled);
    if (finalizers.size === 0) activeNativeFinalizers.delete(requestLogId);
  });
  return operation;
}

export function assertNativeRunAdmission(): void {
  if (isRestartPending()) throw restartUnavailable();
}

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

function isParseableJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
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
  assertNativeRunAdmission();

  let requestLogId: number;
  let stepIndex = 0;

  // requestLogId 가 있을 때만 기존 run 연장. threadCoord 만 있는 conv 는 새 run 으로 시작.
  // continuation 은 createRun 을 건너뛰므로 run 의 tools 는 첫 스텝 장착분으로 고정된다 —
  // AI SDK prepareStep/activeTools 로 스텝마다 툴셋이 바뀌어도 로그에는 반영되지 않는다.
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
      tools: args.tools?.length ? args.tools : undefined,
      is_image_generation: args.imageGeneration,
    });
  }

  // DB 준비 중에 재시작이 시작됐다면 provider 실행으로 넘어가지 않는다.
  // 이 요청은 재시작 snapshot에 없었으므로 방금 준비한 run을 직접 마감한다.
  if (isRestartPending()) {
    await finishTerminalRun(requestLogId, "error", "server restarted");
    throw restartUnavailable();
  }

  registerNativeRun(requestLogId);
  return { requestLogId, stepIndex };
}

export async function afterQuery(
  requestLogId: number,
  stepIndex: number,
  args: QueryInput,
  result: QueryOutput,
): Promise<RunLifecycleResult> {
  if (interruptedNativeRunIds.has(requestLogId)) return {};

  return trackNativeFinalizer(requestLogId, async () => {
    try {
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
      const responseText = formatResponseForLog(result);
      await RequestLogModel.finishRun(requestLogId, {
        status: "succeeded",
        response: responseText,
        // structured 요청만 판정한다. deti 배치의 broken JSON 류를 목록에서 바로
        // 구별하기 위한 기록이며, 비structured 요청은 null 로 남는다.
        response_json_ok: args.jsonSchema ? isParseableJson(responseText) : null,
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
          imageCostMicroUsd !== null
            ? imageGenerationCostMethod(args.imageGenerationOptions)
            : null,
        history: filterHistoryForStorage(args.history),
      });

      return {};
    } finally {
      releaseNativeRun(requestLogId);
    }
  });
}

export async function finishRunWithError(
  requestLogId: number,
  errorMessage: string,
  args?: QueryInput,
): Promise<void> {
  if (interruptedNativeRunIds.has(requestLogId)) return;
  return trackNativeFinalizer(requestLogId, async () => {
    try {
      await finishTerminalRun(requestLogId, "error", errorMessage, args);
    } finally {
      releaseNativeRun(requestLogId);
    }
  });
}

export async function finishRunAborted(requestLogId: number, args?: QueryInput): Promise<void> {
  if (interruptedNativeRunIds.has(requestLogId)) return;
  return trackNativeFinalizer(requestLogId, async () => {
    try {
      await finishTerminalRun(requestLogId, "aborted", "client disconnected", args);
    } finally {
      releaseNativeRun(requestLogId);
    }
  });
}

/** 현재 이 프로세스가 provider를 실행 중인 native run만 재시작 오류로 마감한다. */
export async function finishActiveNativeRunsForRestart(): Promise<void> {
  const requestLogIds = [...activeNativeRunRefs.keys()];
  for (const requestLogId of requestLogIds) {
    interruptedNativeRunIds.add(requestLogId);
    activeNativeRunRefs.delete(requestLogId);
  }

  await Promise.all(
    requestLogIds.map(async (requestLogId) => {
      await Promise.all(activeNativeFinalizers.get(requestLogId) ?? []);
      await finishTerminalRun(requestLogId, "error", "server restarted");
    }),
  );
}

/** 프로세스 전역 registry를 격리해야 하는 단위 테스트 전용. */
export function resetNativeRunRegistryForTests(): void {
  activeNativeRunRefs.clear();
  interruptedNativeRunIds.clear();
  activeNativeFinalizers.clear();
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
