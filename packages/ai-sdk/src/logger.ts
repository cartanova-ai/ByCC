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

  async function finalizeRun(
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
  ) {
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
  }

  return {
    async onStart(event) {
      // run key 결정
      const record = getRecord(event);
      const metadata = getRecord(record?.metadata);
      const qgridRunId = metadata?.qgridRunId;
      let runKey = DEFAULT_RUN_KEY;
      if (typeof qgridRunId === "string" && qgridRunId.length > 0)
        runKey = `qgridRunId:${qgridRunId}`;
      else {
        const functionId = record?.functionId;
        if (typeof functionId === "string" && functionId.length > 0)
          runKey = `functionId:${functionId}`;
      }

      if (quarantined.has(runKey)) {
        config.onLogError?.(
          new Error("createQgridLogger: telemetry key is quarantined after overlap"),
        );
        return;
      }

      if ((event.model as { provider?: string })?.provider === "qgrid") {
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
          modelName: (event.model as { modelId?: string })?.modelId,
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
      const record = getRecord(event);
      const metadata = getRecord(record?.metadata);
      const qgridRunId = metadata?.qgridRunId;
      let runKey = DEFAULT_RUN_KEY;
      if (typeof qgridRunId === "string" && qgridRunId.length > 0)
        runKey = `qgridRunId:${qgridRunId}`;
      else {
        const fid = record?.functionId;
        if (typeof fid === "string" && fid.length > 0) runKey = `functionId:${fid}`;
      }

      if (suppressedQgrid.has(runKey) || quarantined.has(runKey)) return;
      const run = runs.get(runKey);
      if (!run) return;
      const toolCallId = (event.toolCall as { toolCallId?: string })?.toolCallId;
      if (toolCallId && typeof event.durationMs === "number") {
        run.toolDurations.set(toolCallId, Math.round(event.durationMs));
      }
    },

    onStepFinish(event) {
      const record = getRecord(event);
      const metadata = getRecord(record?.metadata);
      const qgridRunId = metadata?.qgridRunId;
      let runKey = DEFAULT_RUN_KEY;
      if (typeof qgridRunId === "string" && qgridRunId.length > 0)
        runKey = `qgridRunId:${qgridRunId}`;
      else {
        const fid = record?.functionId;
        if (typeof fid === "string" && fid.length > 0) runKey = `functionId:${fid}`;
      }

      if (suppressedQgrid.has(runKey) || quarantined.has(runKey)) return;
      const run = runs.get(runKey);
      if (!run) return;

      const stepNumber = (event as { stepNumber?: number }).stepNumber ?? 0;
      const usage = event.usage as {
        inputTokens?: number;
        outputTokens?: number;
        inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
        outputTokenDetails?: { reasoningTokens?: number };
      };
      const content =
        (
          event as {
            content?: Array<{
              type: string;
              toolCallId?: string;
              toolName?: string;
              input?: unknown;
              output?: unknown;
              error?: unknown;
              text?: string;
            }>;
          }
        ).content ?? [];

      // reasoning
      const reasoningParts = content.filter((p) => p.type === "reasoning") as Array<{
        text?: string;
      }>;
      const reasoningFromContent = reasoningParts.map((p) => p.text ?? "").join("");
      const reasoningRaw = (event as { reasoningText?: unknown }).reasoningText;
      const reasoningText =
        typeof reasoningRaw === "string" && reasoningRaw.length > 0
          ? reasoningRaw
          : reasoningFromContent.length > 0
            ? reasoningFromContent
            : undefined;

      // 이전 step의 pending tool-call 매칭
      const toolResults = content.filter((p) => p.type === "tool-result") as Array<{
        toolCallId: string;
        output: unknown;
      }>;
      const toolErrors = content.filter((p) => p.type === "tool-error") as Array<{
        toolCallId: string;
        error: unknown;
      }>;

      const remainingPending: PendingToolCall[] = [];
      for (const pending of run.pendingToolCalls) {
        const tr = toolResults.find((r) => r.toolCallId === pending.toolCallId);
        const te = toolErrors.find((e) => e.toolCallId === pending.toolCallId);
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
              toolResult: tr ? safeStringify(tr.output) : undefined,
              toolDurationMs: run.toolDurations.get(pending.toolCallId),
              error: te ? safeStringify(te.error) : undefined,
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
          finishReason: event.finishReason as string,
          reasoningText:
            typeof reasoningText === "string" && reasoningText.length > 0
              ? reasoningText
              : undefined,
          reasoningTokens: usage.outputTokenDetails?.reasoningTokens,
        }).catch((e) => config.onLogError?.(e instanceof Error ? e : new Error(String(e)))),
      );

      // 이번 step의 새 tool-call
      const toolCalls = content.filter((p) => p.type === "tool-call") as Array<{
        toolCallId: string;
        toolName: string;
        input: unknown;
      }>;
      for (const [i, tc] of toolCalls.entries()) {
        const tr = toolResults.find((r) => r.toolCallId === tc.toolCallId);
        const te = toolErrors.find((e) => e.toolCallId === tc.toolCallId);
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
              toolResult: tr ? safeStringify(tr.output) : undefined,
              toolDurationMs: run.toolDurations.get(tc.toolCallId),
              error: te ? safeStringify(te.error) : undefined,
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
      const record = getRecord(event);
      const metadata = getRecord(record?.metadata);
      const qgridRunId = metadata?.qgridRunId;
      let runKey = DEFAULT_RUN_KEY;
      if (typeof qgridRunId === "string" && qgridRunId.length > 0)
        runKey = `qgridRunId:${qgridRunId}`;
      else {
        const fid = record?.functionId;
        if (typeof fid === "string" && fid.length > 0) runKey = `functionId:${fid}`;
      }

      if (suppressedQgrid.has(runKey)) {
        suppressedQgrid.remove(runKey);
        return;
      }
      if (quarantined.has(runKey)) return;

      const run = runs.get(runKey);
      if (!run) return;

      const finishReason = event.finishReason as string;
      const status =
        finishReason === "error"
          ? ("error" as const)
          : finishReason === "abort"
            ? ("aborted" as const)
            : ("succeeded" as const);

      const totalUsage = (
        event as {
          totalUsage?: {
            inputTokens?: number;
            outputTokens?: number;
            inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
          };
        }
      ).totalUsage;

      await finalizeRun(runKey, {
        status,
        response: event.text,
        totalUsage,
        ...(status === "error"
          ? { errorMessage: getErrorMessage((event as { error?: unknown }).error) }
          : {}),
      });
    },
  };
}
