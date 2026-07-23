import { type TelemetryIntegration, type TelemetrySettings } from "ai";

import { type QgridLoggerConfig } from "./index.types";
import { DEFAULT_QGRID_SERVER_URL } from "./qgrid.constant";
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
  modelName?: string;
  requestedModelName: string;
};

type RunState = {
  requestLogId: number;
  requestedModelName: string;
  pendingSteps: Promise<unknown>[];
  pendingToolCalls: PendingToolCall[];
  startTime: number;
  toolDurations: Map<string, number>;
  watchdog?: ReturnType<typeof setTimeout>;
  cleanupAbortListener?: () => void;
  finishing: boolean;
};

type StartReservation = {
  requestedModelName: string;
  startTime: number;
  errorMessage?: string;
};

const DEFAULT_RUN_KEY = "__qgrid_default_run__";
const DEFAULT_STALE_RUN_TIMEOUT_MS = 30 * 60 * 1000;
const STALE_RUN_GRACE_MS = 5000;
const OVERLAPPING_RUN_ERROR =
  "createQgridLogger received overlapping runs for the same telemetry key. Pass a unique metadata.qgridRunId per AI SDK call or create a fresh logger integration per call.";

function fullModelName(provider: string | undefined, modelId: string | undefined) {
  if (!provider || !modelId) return undefined;
  const baseProvider = provider.split(".", 1)[0] ?? provider;
  const prefix = `${baseProvider}/`;
  return modelId.startsWith(prefix) ? modelId : `${prefix}${modelId}`;
}

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

export function createQgridLogger(config: QgridLoggerConfig = {}): TelemetrySettings {
  const serverUrl = config.serverUrl ?? process.env.QGRID_URL ?? DEFAULT_QGRID_SERVER_URL;
  const projectName = config.projectName ?? process.env.QGRID_PROJECT_NAME;
  const onLogError =
    config.onLogError ?? ((e: Error) => console.warn(`[qgrid-logger] ${e.message}`));
  const runs = new Map<string, RunState>();
  const starting = new Map<string, StartReservation>();
  const keyTtl =
    typeof config.staleRunTimeoutMs === "number" && config.staleRunTimeoutMs > 0
      ? config.staleRunTimeoutMs
      : DEFAULT_STALE_RUN_TIMEOUT_MS;

  const suppressedRuns = timedKeySet();
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
      modelName?: string;
      requestedModelName?: string;
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
        appendStep(serverUrl, {
          requestLogId: run.requestLogId,
          stepIndex: pending.stepIndex,
          type: "tool_call",
          toolCallIndex: pending.toolCallIndex,
          toolCallId: pending.toolCallId,
          toolName: pending.toolName,
          toolArgs: pending.toolArgs,
          modelName: pending.modelName,
          requestedModelName: pending.requestedModelName,
          toolDurationMs: run.toolDurations.get(pending.toolCallId),
        }).catch((e) => onLogError(e instanceof Error ? e : new Error(String(e)))),
      );
    }
    run.pendingToolCalls = [];

    await Promise.allSettled(run.pendingSteps);
    await finishRun(serverUrl, {
      requestLogId: run.requestLogId,
      status: result.status,
      response: result.response,
      tokenName: config.tokenName ?? "external",
      modelName: result.modelName,
      requestedModelName: result.requestedModelName ?? run.requestedModelName,
      totalInputTokens: result.totalUsage?.inputTokens ?? 0,
      totalOutputTokens: result.totalUsage?.outputTokens ?? 0,
      totalCacheReadTokens: result.totalUsage?.inputTokenDetails?.cacheReadTokens ?? 0,
      totalCacheCreationTokens: result.totalUsage?.inputTokenDetails?.cacheWriteTokens ?? 0,
      totalDurationMs: Date.now() - run.startTime,
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
    }).catch((e) => onLogError(e instanceof Error ? e : new Error(String(e))));
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

      // qgrid provider requests own their server-side logging lifecycle. Later
      // hooks also expose model.provider, so they do not need shared key state.
      if (event.model.provider === "qgrid") return;

      if (quarantined.has(runKey)) {
        onLogError(new Error("createQgridLogger: telemetry key is quarantined after overlap"));
        return;
      }

      if (runs.has(runKey) || starting.has(runKey) || suppressedRuns.has(runKey)) {
        const reservation = starting.get(runKey);
        if (reservation) {
          reservation.errorMessage = OVERLAPPING_RUN_ERROR;
          starting.delete(runKey);
        }
        suppressedRuns.remove(runKey);
        quarantined.add(runKey, keyTtl);
        const finalizing = finalizeRun(runKey, {
          status: "error",
          errorMessage: OVERLAPPING_RUN_ERROR,
        });
        onLogError(new Error(OVERLAPPING_RUN_ERROR));
        await finalizing;
        return;
      }

      if (event.providerOptions?.qgrid?.logger === false) {
        suppressedRuns.add(runKey, keyTtl);
        return;
      }

      const requestedModelName =
        fullModelName(event.model.provider, event.model.modelId) ?? event.model.modelId;
      const reservation: StartReservation = {
        requestedModelName,
        startTime: Date.now(),
      };
      starting.set(runKey, reservation);

      try {
        const messages = event.messages ?? (Array.isArray(event.prompt) ? event.prompt : undefined);
        const history = serializeHistory(messages);
        const result = await createRun(serverUrl, {
          userPrompt: extractUserPrompt(event.prompt, messages),
          systemPrompt: extractSystemPrompt(event.system),
          modelName: requestedModelName,
          projectName,
          history,
        });

        if (
          reservation.errorMessage ||
          quarantined.has(runKey) ||
          starting.get(runKey) !== reservation
        ) {
          if (starting.get(runKey) === reservation) starting.delete(runKey);
          await finishRun(serverUrl, {
            requestLogId: result.requestLogId,
            status: "error",
            tokenName: config.tokenName ?? "external",
            requestedModelName: reservation.requestedModelName,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalCacheReadTokens: 0,
            totalCacheCreationTokens: 0,
            totalDurationMs: Date.now() - reservation.startTime,
            errorMessage: reservation.errorMessage ?? OVERLAPPING_RUN_ERROR,
          }).catch((e) => onLogError(e instanceof Error ? e : new Error(String(e))));
          return;
        }

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

        starting.delete(runKey);
        runs.set(runKey, {
          requestLogId: result.requestLogId,
          requestedModelName,
          pendingSteps: [],
          pendingToolCalls: [],
          startTime: Date.now(),
          toolDurations: new Map(),
          watchdog,
          cleanupAbortListener,
          finishing: false,
        });
      } catch (e) {
        if (starting.get(runKey) === reservation) starting.delete(runKey);
        onLogError(e instanceof Error ? e : new Error(String(e)));
      }
    },

    onToolCallFinish(event) {
      if (event.model?.provider === "qgrid") return;
      const runKey = resolveRunKey(event);
      if (suppressedRuns.has(runKey) || quarantined.has(runKey)) return;
      const run = runs.get(runKey);
      if (!run) return;
      run.toolDurations.set(event.toolCall.toolCallId, Math.round(event.durationMs));
    },

    onStepFinish(event) {
      if (event.model?.provider === "qgrid") return;
      const runKey = resolveRunKey(event);
      if (suppressedRuns.has(runKey) || quarantined.has(runKey)) return;
      const run = runs.get(runKey);
      if (!run) return;

      const { content, usage, reasoningText, finishReason, stepNumber } = event;
      const requestedModelName =
        fullModelName(event.model?.provider, event.model?.modelId) ?? run.requestedModelName;
      const modelName = fullModelName(event.model?.provider, event.response?.modelId);

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
            appendStep(serverUrl, {
              requestLogId: run.requestLogId,
              stepIndex: pending.stepIndex,
              type: "tool_call",
              toolCallIndex: pending.toolCallIndex,
              toolCallId: pending.toolCallId,
              toolName: pending.toolName,
              toolArgs: pending.toolArgs,
              modelName: pending.modelName,
              requestedModelName: pending.requestedModelName,
              toolResult: tr && "output" in tr ? safeStringify(tr.output) : undefined,
              toolDurationMs: run.toolDurations.get(pending.toolCallId),
              error: te && "error" in te ? safeStringify(te.error) : undefined,
            }).catch((e) => onLogError(e instanceof Error ? e : new Error(String(e)))),
          );
          run.toolDurations.delete(pending.toolCallId);
        } else {
          remainingPending.push(pending);
        }
      }
      run.pendingToolCalls = remainingPending;

      // generate step
      run.pendingSteps.push(
        appendStep(serverUrl, {
          requestLogId: run.requestLogId,
          stepIndex: stepNumber,
          type: "generate",
          modelName,
          requestedModelName,
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
        }).catch((e) => onLogError(e instanceof Error ? e : new Error(String(e)))),
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
            appendStep(serverUrl, {
              requestLogId: run.requestLogId,
              stepIndex: stepNumber,
              type: "tool_call",
              toolCallIndex: i,
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              toolArgs: safeStringify(tc.input),
              modelName,
              requestedModelName,
              toolResult: tr && "output" in tr ? safeStringify(tr.output) : undefined,
              toolDurationMs: run.toolDurations.get(tc.toolCallId),
              error: te && "error" in te ? safeStringify(te.error) : undefined,
            }).catch((e) => onLogError(e instanceof Error ? e : new Error(String(e)))),
          );
          run.toolDurations.delete(tc.toolCallId);
        } else {
          run.pendingToolCalls.push({
            stepIndex: stepNumber,
            toolCallIndex: i,
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            toolArgs: safeStringify(tc.input),
            modelName,
            requestedModelName,
          });
        }
      }
    },

    async onFinish(event) {
      if (event.model?.provider === "qgrid") return;
      const runKey = resolveRunKey(event);

      if (suppressedRuns.has(runKey)) {
        suppressedRuns.remove(runKey);
        return;
      }
      if (quarantined.has(runKey)) return;

      const run = runs.get(runKey);
      if (!run) return;

      const status = event.finishReason === "error" ? "error" : "succeeded";
      const requestedModelName =
        fullModelName(event.model?.provider, event.model?.modelId) ?? run.requestedModelName;
      const modelName = fullModelName(event.model?.provider, event.response?.modelId);

      await finalizeRun(runKey, {
        status,
        response: event.text,
        totalUsage: event.totalUsage,
        modelName,
        requestedModelName,
        ...(status === "error" && "error" in event
          ? { errorMessage: getErrorMessage(event.error) }
          : {}),
      });
    },
  };

  return { isEnabled: true, integrations: [integration] };
}
