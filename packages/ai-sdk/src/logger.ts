

import type { TelemetryIntegration } from "ai";
import type { QgridLoggerConfig } from "./index.types";
import { appendStep, createRun, finishRun } from "./utils";

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
};

const DEFAULT_RUN_KEY = "__qgrid_default_run__";

function safeStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

export function createQgridLogger(config: QgridLoggerConfig): TelemetryIntegration {
  const runs = new Map<string, RunState>();
  const skippedRuns = new Set<string>();

  function handleLogError(err: unknown) {
    if (config.onLogError) {
      config.onLogError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  function getRunKey(event: unknown): string {
    const record = getRecord(event);
    const metadata = getRecord(record?.metadata);
    const qgridRunId = metadata?.qgridRunId;
    if (typeof qgridRunId === "string" && qgridRunId.length > 0) return `qgridRunId:${qgridRunId}`;
    const functionId = record?.functionId;
    if (typeof functionId === "string" && functionId.length > 0) return `functionId:${functionId}`;
    return DEFAULT_RUN_KEY;
  }

  function extractTextContent(content: unknown): string {
    if (typeof content === "string") return content;
    const parts: string[] = [];
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part === "object" && "type" in part) {
          if (part.type === "text" && "text" in part && typeof part.text === "string") {
            parts.push(part.text);
          }
        }
      }
    }
    return parts.join("\n");
  }

  function getRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  }

  function extractUserPrompt(prompt: unknown, messages: unknown): string {
    if (typeof prompt === "string") return prompt;
    const messageList = Array.isArray(messages) ? messages : Array.isArray(prompt) ? prompt : [];
    for (let i = messageList.length - 1; i >= 0; i--) {
      const msg = getRecord(messageList[i]);
      if (msg?.role === "user") {
        return extractTextContent(msg.content);
      }
    }
    return "";
  }

  function extractSystemPrompt(system: unknown): string | undefined {
    if (typeof system === "string") return system;
    if (system && typeof system === "object" && "content" in system) {
      const content = (system as { content: unknown }).content;
      if (typeof content === "string") return content;
    }
    return undefined;
  }

  function serializeHistory(messages: unknown): string | undefined {
    if (!Array.isArray(messages) || messages.length === 0) return undefined;
    const filtered = messages
      .map((msg) => getRecord(msg))
      .filter((record): record is Record<string, unknown> =>
        record?.role === "user" || record?.role === "assistant",
      )
      .map((record) => ({
        type: "message",
        role: record.role as string,
        content: extractTextContent(record.content),
      }))
      .filter((entry) => entry.content.length > 0);
    if (filtered.length === 0) return undefined;
    return safeStringify(filtered);
  }

  return {
    async onStart(event) {
      const runKey = getRunKey(event);
      skippedRuns.delete(runKey);

      if ((event.model as { provider?: string })?.provider === "qgrid") {
        skippedRuns.add(runKey);
        return;
      }

      if (runs.has(runKey)) {
        skippedRuns.add(runKey);
        handleLogError(
          new Error(
            "createQgridLogger received overlapping runs for the same telemetry key. Pass a unique metadata.qgridRunId per AI SDK call or create a fresh logger integration per call.",
          ),
        );
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
        runs.set(runKey, {
          requestLogId: result.requestLogId,
          pendingSteps: [],
          pendingToolCalls: [],
          startTime: Date.now(),
          toolDurations: new Map(),
          history: serializeHistory(messages),
        });
      } catch (e) {
        handleLogError(e);
      }
    },

    onToolCallFinish(event) {
      const runKey = getRunKey(event);
      if (skippedRuns.has(runKey)) return;
      const run = runs.get(runKey);
      if (!run) return;
      const toolCallId = (event.toolCall as { toolCallId?: string })?.toolCallId;
      if (toolCallId && typeof event.durationMs === "number") {
        run.toolDurations.set(toolCallId, Math.round(event.durationMs));
      }
    },

    onStepFinish(event) {
      const runKey = getRunKey(event);
      if (skippedRuns.has(runKey)) return;
      const run = runs.get(runKey);
      if (!run) return;

      const stepNumber = (event as { stepNumber?: number }).stepNumber ?? 0;
      const usage = event.usage as {
        inputTokens?: number;
        outputTokens?: number;
        inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
        outputTokenDetails?: { reasoningTokens?: number };
      };
      const content = (event as { content?: Array<{ type: string; toolCallId?: string; toolName?: string; input?: unknown; output?: unknown; error?: unknown; text?: string }> }).content ?? [];

      // reasoningText는 getter라서 telemetry로 넘어올 때 유실될 수 있음 — content에서 직접 추출
      const reasoningParts = content.filter((p) => p.type === "reasoning") as Array<{ text?: string }>;
      const reasoningTextFromContent = reasoningParts.map((p) => p.text ?? "").join("");
      const reasoningTextRaw = (event as { reasoningText?: unknown }).reasoningText;
      const reasoningText =
        typeof reasoningTextRaw === "string" && reasoningTextRaw.length > 0
          ? reasoningTextRaw
          : reasoningTextFromContent.length > 0
            ? reasoningTextFromContent
            : undefined;

      // tool-result/tool-error는 이전 step의 tool-call에 대한 결과 — 먼저 처리
      const toolResults = content.filter((p) => p.type === "tool-result") as Array<{ toolCallId: string; output: unknown }>;
      const toolErrors = content.filter((p) => p.type === "tool-error") as Array<{ toolCallId: string; error: unknown }>;

      const remainingPendingToolCalls: PendingToolCall[] = [];
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
            }).catch(handleLogError),
          );
          run.toolDurations.delete(pending.toolCallId);
        } else {
          remainingPendingToolCalls.push(pending);
        }
      }
      run.pendingToolCalls = remainingPendingToolCalls;

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
          reasoningText: typeof reasoningText === "string" && reasoningText.length > 0 ? reasoningText : undefined,
          reasoningTokens: usage.outputTokenDetails?.reasoningTokens,
        }).catch(handleLogError),
      );

      // 이번 step의 tool-call들
      const toolCalls = content.filter((p) => p.type === "tool-call") as Array<{ toolCallId: string; toolName: string; input: unknown }>;
      for (const [i, tc] of toolCalls.entries()) {
        const tr = toolResults.find((r) => r.toolCallId === tc.toolCallId);
        const te = toolErrors.find((e) => e.toolCallId === tc.toolCallId);
        if (tr || te) {
          // 같은 step에 result/error가 있으면 바로 기록 (에러 시 동일 step에 포함됨)
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
            }).catch(handleLogError),
          );
          run.toolDurations.delete(tc.toolCallId);
        } else {
          // result가 아직 없으면 다음 step에서 매칭
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
      const runKey = getRunKey(event);
      if (skippedRuns.has(runKey)) {
        skippedRuns.delete(runKey);
        return;
      }
      const run = runs.get(runKey);
      if (!run) return;

      // 남은 pendingToolCalls — result 없이 기록 (마지막 step에서 tool-call만 있고 끝난 경우)
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
          }).catch(handleLogError),
        );
      }
      run.pendingToolCalls = [];

      await Promise.allSettled(run.pendingSteps);

      const finishReason = event.finishReason as string;
      const status =
        finishReason === "error" ? "error" as const
        : finishReason === "abort" ? "aborted" as const
        : "succeeded" as const;

      const totalUsage = (event as { totalUsage?: {
        inputTokens?: number;
        outputTokens?: number;
        inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
      } }).totalUsage;

      await finishRun(config.serverUrl, {
        requestLogId: run.requestLogId,
        status,
        response: (event as { text?: string }).text,
        tokenName: config.tokenName ?? "external",
        totalInputTokens: totalUsage?.inputTokens ?? 0,
        totalOutputTokens: totalUsage?.outputTokens ?? 0,
        totalCacheReadTokens: totalUsage?.inputTokenDetails?.cacheReadTokens ?? 0,
        totalCacheCreationTokens: totalUsage?.inputTokenDetails?.cacheWriteTokens ?? 0,
        totalDurationMs: Date.now() - run.startTime,
        history: run.history,
        ...(status === "error" ? { errorMessage: String((event as { error?: unknown }).error) } : {}),
      }).catch(handleLogError);

      runs.delete(runKey);
    },
  };
}
