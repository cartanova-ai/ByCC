import { type TelemetryIntegration } from "ai";

import { type QgridLoggerConfig } from "./index.types";
import {
  appendStep,
  createRun,
  extractSystemPrompt,
  extractUserPrompt,
  finishRun,
  getErrorMessage,
  getRecord,
  safeStringify,
  serializeHistory,
} from "./utils";

type PendingToolCall = {
  stepIndex: number;
  toolCallIndex: number;
  toolCallId: string;
  toolName: string;
  toolArgs: string;
};

type RunState = {
  requestLogId: number;
  pendingSteps: Promise<unknown>[];
  pendingToolCalls: PendingToolCall[];
  startTime: number;
  toolDurations: Map<string, number>;
  history?: string;
  watchdog?: ReturnType<typeof setTimeout>;
  cleanupAbortListener?: () => void;
  finishing: boolean;
};

const DEFAULT_RUN_KEY = "__qgrid_default_run__";
const DEFAULT_STALE_RUN_TIMEOUT_MS = 30 * 60 * 1000;
const STALE_RUN_GRACE_MS = 5000;

function timedKeySet() {
  const keys = new Set<string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  return {
    has: (k: string) => keys.has(k),
    add(k: string, ttlMs: number) {
      keys.add(k);
      const existing = timers.get(k);
      if (existing) clearTimeout(existing);
      const t = setTimeout(() => {
        keys.delete(k);
        timers.delete(k);
      }, ttlMs);
      t.unref?.();
      timers.set(k, t);
    },
    remove(k: string) {
      keys.delete(k);
      const t = timers.get(k);
      if (t) clearTimeout(t);
      timers.delete(k);
    },
  };
}

export function createQgridLogger(config: QgridLoggerConfig): TelemetryIntegration {
  const runs = new Map<string, RunState>();
  const keyTtl =
    typeof config.staleRunTimeoutMs === "number" && config.staleRunTimeoutMs > 0
      ? config.staleRunTimeoutMs
      : DEFAULT_STALE_RUN_TIMEOUT_MS;

  const suppressedQgrid = timedKeySet();
  const quarantined = timedKeySet();

  const finalizeRun = async (
    runKey: string,
    result: {
      status: "succeeded" | "error" | "aborted";
      response?: string;
      errorMessage?: string;
      totalUsage?: {
        inputTokens?: number;
        outputTokens?: number;
        inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
      };
    },
  ) => {
    const run = runs.get(runKey);
    if (!run || run.finishing) return;
    run.finishing = true;
    runs.delete(runKey);
    if (run.watchdog) clearTimeout(run.watchdog);
    run.cleanupAbortListener?.();

    for (const pending of run.pendingToolCalls) {
      run.pendingSteps.push(
        appendStep(config.serverUrl, {
          requestLogId: run.requestLogId,
          stepIndex: pending.stepIndex,
          type: "tool_call",
          toolCallIndex: pending.toolCallIndex,
          toolCallId: pending.toolCallId,
          toolName: pending.toolName,
          toolArgs: pending.toolArgs,
          toolDurationMs: run.toolDurations.get(pending.toolCallId),
        }).catch((e) => config.onLogError?.(e instanceof Error ? e : new Error(String(e)))),
      );
    }
    run.pendingToolCalls = [];

    await Promise.allSettled(run.pendingSteps);
    await finishRun(config.serverUrl, {
      requestLogId: run.requestLogId,
      status: result.status,
      response: result.response,
      tokenName: config.tokenName ?? "external",
      totalInputTokens: result.totalUsage?.inputTokens ?? 0,
      totalOutputTokens: result.totalUsage?.outputTokens ?? 0,
      totalCacheReadTokens: result.totalUsage?.inputTokenDetails?.cacheReadTokens ?? 0,
      totalCacheCreationTokens: result.totalUsage?.inputTokenDetails?.cacheWriteTokens ?? 0,
      totalDurationMs: Date.now() - run.startTime,
      history: run.history,
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
    }).catch((e) => config.onLogError?.(e instanceof Error ? e : new Error(String(e))));
  };

  let autoRunIdCounter = 0;

  const resolveRunKey = (event: {
    metadata?: Record<string, unknown>;
    functionId?: string;
  }): string => {
    const qgridRunId = event.metadata?.qgridRunId;
    if (typeof qgridRunId === "string" && qgridRunId.length > 0) return `qgridRunId:${qgridRunId}`;
    if (typeof event.functionId === "string" && event.functionId.length > 0)
      return `functionId:${event.functionId}`;
    return DEFAULT_RUN_KEY;
  };

  const integration: TelemetryIntegration = {
    async onStart(event) {
      // qgridRunId/functionId가 없으면 자동 생성 → 병렬 호출 시 run 자동 분리
      // metadata 객체 참조가 같은 generation의 모든 hook에서 공유되므로 이후 hook에서도 동일 key
      if (!event.metadata?.qgridRunId && !event.functionId && event.metadata) {
        event.metadata.qgridRunId = `auto-${++autoRunIdCounter}`;
      }
      const runKey = resolveRunKey(event);
      if (quarantined.has(runKey)) {
        config.onLogError?.(
          new Error("createQgridLogger: telemetry key is quarantined after overlap"),
        );
        return;
      }

      if (event.model.provider === "qgrid") {
        suppressedQgrid.add(runKey, keyTtl);
        return;
      }

      if (runs.has(runKey)) {
        const msg =
          "createQgridLogger received overlapping runs for the same telemetry key. Pass a unique metadata.qgridRunId per AI SDK call or create a fresh logger integration per call.";
        await finalizeRun(runKey, { status: "error", errorMessage: msg });
        quarantined.add(runKey, keyTtl);
        config.onLogError?.(new Error(msg));
        return;
      }

      try {
        const messages = event.messages ?? (Array.isArray(event.prompt) ? event.prompt : undefined);
        const result = await createRun(config.serverUrl, {
          userPrompt: extractUserPrompt(event.prompt, messages),
          systemPrompt: extractSystemPrompt(event.system),
          modelName: event.model.modelId,
          projectName: config.projectName,
        });

        // watchdog timeout
        let watchdogTimeout = DEFAULT_STALE_RUN_TIMEOUT_MS;
        if (typeof config.staleRunTimeoutMs === "number")
          watchdogTimeout = config.staleRunTimeoutMs;
        else if (typeof event.timeout === "number" && event.timeout > 0)
          watchdogTimeout = event.timeout + STALE_RUN_GRACE_MS;
        else {
          const rec = getRecord(event.timeout);
          const totalMs = rec?.totalMs;
          if (typeof totalMs === "number" && totalMs > 0)
            watchdogTimeout = totalMs + STALE_RUN_GRACE_MS;
        }

        let watchdog: ReturnType<typeof setTimeout> | undefined;
        if (watchdogTimeout > 0) {
          watchdog = setTimeout(() => {
            void finalizeRun(runKey, {
              status: "error",
              errorMessage: "AI SDK generation ended before onFinish was emitted",
            });
          }, watchdogTimeout);
          watchdog.unref?.();
        }

        // abort listener
        let cleanupAbortListener: (() => void) | undefined;
        const signal = event.abortSignal;
        if (signal) {
          const onAbort = () => {
            void finalizeRun(runKey, {
              status: "aborted",
              errorMessage: getErrorMessage(signal.reason),
            });
          };
          if (signal.aborted) queueMicrotask(onAbort);
          else {
            signal.addEventListener("abort", onAbort, { once: true });
            cleanupAbortListener = () => signal.removeEventListener("abort", onAbort);
          }
        }

        runs.set(runKey, {
          requestLogId: result.requestLogId,
          pendingSteps: [],
          pendingToolCalls: [],
          startTime: Date.now(),
          toolDurations: new Map(),
          history: serializeHistory(messages),
          watchdog,
          cleanupAbortListener,
          finishing: false,
        });
      } catch (e) {
        config.onLogError?.(e instanceof Error ? e : new Error(String(e)));
      }
    },

    onToolCallFinish(event) {
      const runKey = resolveRunKey(event);
      if (suppressedQgrid.has(runKey) || quarantined.has(runKey)) return;
      const run = runs.get(runKey);
      if (!run) return;
      run.toolDurations.set(event.toolCall.toolCallId, Math.round(event.durationMs));
    },

    onStepFinish(event) {
      const runKey = resolveRunKey(event);
      if (suppressedQgrid.has(runKey) || quarantined.has(runKey)) return;
      const run = runs.get(runKey);
      if (!run) return;

      const { content, usage, reasoningText, finishReason, stepNumber } = event;

      // 이전 step의 pending tool-call 매칭
      const remainingPending: PendingToolCall[] = [];
      for (const pending of run.pendingToolCalls) {
        const tr = content.find(
          (p) => p.type === "tool-result" && p.toolCallId === pending.toolCallId,
        );
        const te = content.find(
          (p) => p.type === "tool-error" && p.toolCallId === pending.toolCallId,
        );
        // tool call 에러도 step으로 간주
        if (tr || te) {
          run.pendingSteps.push(
            appendStep(config.serverUrl, {
              requestLogId: run.requestLogId,
              stepIndex: pending.stepIndex,
              type: "tool_call",
              toolCallIndex: pending.toolCallIndex,
              toolCallId: pending.toolCallId,
              toolName: pending.toolName,
              toolArgs: pending.toolArgs,
              toolResult: tr && "output" in tr ? safeStringify(tr.output) : undefined,
              toolDurationMs: run.toolDurations.get(pending.toolCallId),
              error: te && "error" in te ? safeStringify(te.error) : undefined,
            }).catch((e) => config.onLogError?.(e instanceof Error ? e : new Error(String(e)))),
          );
          run.toolDurations.delete(pending.toolCallId);
        } else {
          remainingPending.push(pending);
        }
      }
      run.pendingToolCalls = remainingPending;

      // generate step
      run.pendingSteps.push(
        appendStep(config.serverUrl, {
          requestLogId: run.requestLogId,
          stepIndex: stepNumber,
          type: "generate",
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
          cacheCreationTokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
          finishReason,
          reasoningText:
            typeof reasoningText === "string" && reasoningText.length > 0
              ? reasoningText
              : undefined,
          reasoningTokens: usage.outputTokenDetails?.reasoningTokens,
        }).catch((e) => config.onLogError?.(e instanceof Error ? e : new Error(String(e)))),
      );

      // 이번 step의 새 tool-call
      const toolCalls = content.filter(
        (p): p is Extract<(typeof content)[number], { type: "tool-call" }> =>
          p.type === "tool-call",
      );
      for (const [i, tc] of toolCalls.entries()) {
        const tr = content.find((p) => p.type === "tool-result" && p.toolCallId === tc.toolCallId);
        const te = content.find((p) => p.type === "tool-error" && p.toolCallId === tc.toolCallId);
        if (tr || te) {
          run.pendingSteps.push(
            appendStep(config.serverUrl, {
              requestLogId: run.requestLogId,
              stepIndex: stepNumber,
              type: "tool_call",
              toolCallIndex: i,
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              toolArgs: safeStringify(tc.input),
              toolResult: tr && "output" in tr ? safeStringify(tr.output) : undefined,
              toolDurationMs: run.toolDurations.get(tc.toolCallId),
              error: te && "error" in te ? safeStringify(te.error) : undefined,
            }).catch((e) => config.onLogError?.(e instanceof Error ? e : new Error(String(e)))),
          );
          run.toolDurations.delete(tc.toolCallId);
        } else {
          run.pendingToolCalls.push({
            stepIndex: stepNumber,
            toolCallIndex: i,
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            toolArgs: safeStringify(tc.input),
          });
        }
      }
    },

    async onFinish(event) {
      const runKey = resolveRunKey(event);

      if (suppressedQgrid.has(runKey)) {
        suppressedQgrid.remove(runKey);
        return;
      }
      if (quarantined.has(runKey)) return;

      const run = runs.get(runKey);
      if (!run) return;

      const status = event.finishReason === "error" ? "error" : "succeeded";

      await finalizeRun(runKey, {
        status,
        response: event.text,
        totalUsage: event.totalUsage,
        ...(status === "error" && "error" in event
          ? { errorMessage: getErrorMessage(event.error) }
          : {}),
      });
    },
  };
}
