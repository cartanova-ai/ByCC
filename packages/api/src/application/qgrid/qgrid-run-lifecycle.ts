import { getLogger } from "@logtape/logtape";

import { RequestLogModel } from "../request-log/request-log.model";
import {
  type QgridRunContext,
  type QgridToolResultInput,
  type QueryInput,
  type QueryOutput,
} from "./qgrid.types";

const logger = getLogger(["qgrid", "run-lifecycle"]);
const STALE_RUN_THRESHOLD_MS = 30 * 60 * 1000;

function filterHistoryForStorage(rawHistory: string | undefined): unknown | undefined {
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
 * logMode:"run" 시 query/stream 응답 전후에 호출.
 *
 * 1) beforeQuery: run 생성/계속 + tool result 완료 + stale cleanup
 * 2) afterQuery: generate step + tool-call step + finish/keep-open
 */
export async function beforeQuery(args: QueryInput): Promise<{
  requestLogId: number;
  stepIndex: number;
}> {
  await cleanupStaleRuns();

  let requestLogId: number;
  let stepIndex = 0;

  if (args.runContext) {
    requestLogId = args.runContext.requestLogId;

    if (args.toolResults && args.toolResults.length > 0) {
      await completeToolResults(requestLogId, args.toolResults);
    }

    stepIndex = await RequestLogModel.getNextStepIndex(requestLogId);
  } else {
    requestLogId = await RequestLogModel.createRun({
      user_prompt: args.prompt,
      system_prompt: args.system,
      model_name: args.model,
      effort: args.effort,
      project_name: args.projectName,
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
  // generate step 기록
  await RequestLogModel.appendStep(requestLogId, {
    step_index: stepIndex,
    type: "generate",
    input_tokens: result.usage.input_tokens,
    output_tokens: result.usage.output_tokens,
    cache_read_tokens: result.usage.cache_read_input_tokens,
    cache_creation_tokens: result.usage.cache_creation_input_tokens,
    duration_ms: result.durationMs,
    finish_reason: result.finishReason,
  });

  if (result.finishReason === "tool-calls") {
    // tool-call step 즉시 기록 (result는 나중에 completeToolCall로 채움)
    const toolCalls = result.content.filter((c) => c.type === "tool-call");
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i]!;
      if (tc.type !== "tool-call") continue;
      await RequestLogModel.appendStep(requestLogId, {
        step_index: stepIndex,
        type: "tool_call",
        tool_call_index: i,
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
    response: result.text,
    token_name: result.tokenName,
    input_tokens: agg.input_tokens,
    output_tokens: agg.output_tokens,
    cache_read_tokens: agg.cache_read_tokens,
    cache_creation_tokens: agg.cache_creation_tokens,
    duration_ms: agg.duration_ms,
    history: filterHistoryForStorage(args.history),
  });

  return {};
}

export async function finishRunWithError(
  requestLogId: number,
  errorMessage: string,
  args?: QueryInput,
): Promise<void> {
  try {
    await RequestLogModel.finishRun(requestLogId, {
      status: "error",
      error_message: errorMessage,
      history: args ? filterHistoryForStorage(args.history) : undefined,
    });
  } catch (e) {
    logger.error(`finishRunWithError failed: ${(e as Error).message}`);
  }
}

export async function finishRunAborted(
  requestLogId: number,
  args?: QueryInput,
): Promise<void> {
  try {
    await RequestLogModel.finishRun(requestLogId, {
      status: "aborted",
      error_message: "client disconnected",
      history: args ? filterHistoryForStorage(args.history) : undefined,
    });
  } catch (e) {
    logger.error(`finishRunAborted failed: ${(e as Error).message}`);
  }
}

async function completeToolResults(
  requestLogId: number,
  toolResults: QgridToolResultInput[],
): Promise<void> {
  for (const tr of toolResults) {
    try {
      await RequestLogModel.completeToolCall(requestLogId, tr.toolCallId, {
        tool_result: tr.isError ? undefined : tr.output,
        error: tr.isError ? tr.output : undefined,
      });
    } catch (e) {
      logger.error(`completeToolCall failed for ${tr.toolCallId}: ${(e as Error).message}`);
    }
  }
}

async function cleanupStaleRuns(): Promise<void> {
  try {
    const staleIds = await RequestLogModel.findStaleRunningIds(STALE_RUN_THRESHOLD_MS);
    for (const id of staleIds) {
      await RequestLogModel.finishRun(id, {
        status: "error",
        error_message: "tool-call run: no follow-up within 30 minutes",
      });
    }
    if (staleIds.length > 0) {
      logger.info(`cleaned up ${staleIds.length} stale running request logs`);
    }
  } catch (e) {
    logger.error(`stale cleanup failed: ${(e as Error).message}`);
  }
}
