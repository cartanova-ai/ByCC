import {
  type LanguageModelV3,
  type LanguageModelV3CallOptions,
  type LanguageModelV3Content,
  type LanguageModelV3FinishReason,
  type LanguageModelV3FunctionTool,
  type LanguageModelV3GenerateResult,
  type LanguageModelV3StreamPart,
  type LanguageModelV3StreamResult,
} from "@ai-sdk/provider";

import {
  type QgridSupportedModel,
  type QueryOutput,
  type QgridProviderConfig,
} from "./index.types";
import {
  createRun,
  appendStep,
  finishRun,
  extractPromptAndHistory,
  extractToolResultsFromHistory,
  filterHistoryForStorage,
  parseSSE,
  toQgridTool,
} from "./utils";

const DEFAULT_SERVER_URL = "http://localhost:44900";
const DEFAULT_EFFORT = "low";
const STALE_RUN_TIMEOUT_MS = 30 * 60 * 1000;

export function qgrid(modelId: QgridSupportedModel, config?: QgridProviderConfig): LanguageModelV3 {
  const serverUrl = config?.serverUrl ?? process.env.QGRID_URL ?? DEFAULT_SERVER_URL;
  const effort = config?.defaultEffort ?? DEFAULT_EFFORT;

  type PendingToolCall = {
    stepIndex: number;
    toolCallIndex: number;
    callId: string;
    toolName: string;
    args: string;
  };

  type RunState = {
    requestLogId: number;
    stepIndex: number;
    pendingSteps: Promise<unknown>[];
    startTime: number;
    aggUsage: { input: number; output: number; cacheRead: number; cacheCreation: number };
    tokenName?: string;
    model?: string;
    lastTurnEndTime?: number;
    history?: string;
    pendingToolCalls: PendingToolCall[];
  };

  let runState: RunState | null = null;
  let staleTimer: ReturnType<typeof setTimeout> | undefined;

  async function finalizeRun(result: {
    status: "succeeded" | "error" | "aborted";
    response?: string;
    errorMessage?: string;
  }) {
    const rs = runState;
    if (!rs) return;
    runState = null;
    if (staleTimer) {
      clearTimeout(staleTimer);
      staleTimer = undefined;
    }
    for (const pending of rs.pendingToolCalls) {
      rs.pendingSteps.push(
        appendStep(serverUrl, {
          requestLogId: rs.requestLogId,
          stepIndex: pending.stepIndex,
          type: "tool_call",
          toolCallIndex: pending.toolCallIndex,
          toolCallId: pending.callId,
          toolName: pending.toolName,
          toolArgs: pending.args,
        }).catch(() => {}),
      );
    }
    rs.pendingToolCalls = [];
    await Promise.allSettled(rs.pendingSteps);
    await finishRun(serverUrl, {
      requestLogId: rs.requestLogId,
      status: result.status,
      response: result.response,
      tokenName: rs.tokenName,
      totalInputTokens: rs.aggUsage.input,
      totalOutputTokens: rs.aggUsage.output,
      totalCacheReadTokens: rs.aggUsage.cacheRead,
      totalCacheCreationTokens: rs.aggUsage.cacheCreation,
      totalDurationMs: Date.now() - rs.startTime,
      history: rs.history,
      errorMessage: result.errorMessage,
    }).catch(() => {});
  }

  return {
    specificationVersion: "v3",
    provider: "qgrid",
    modelId,
    supportedUrls: {},

    async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
      const tools = options.tools?.filter(
        (t): t is LanguageModelV3FunctionTool => t.type === "function",
      );
      const hasTools = tools && tools.length > 0;
      const { prompt, system, history } = extractPromptAndHistory(options.prompt);

      const openaiOpts = options.providerOptions?.openai as Record<string, unknown> | undefined;
      const effectiveEffort = (openaiOpts?.reasoningEffort as string) ?? effort;
      const verbosity = (openaiOpts?.textVerbosity ?? openaiOpts?.verbosity) as string | undefined;
      const reasoningSummary = openaiOpts?.reasoningSummary as string | undefined;
      const serviceTier = openaiOpts?.serviceTier as string | undefined;

      // --- run state 결정 ---
      let rs: RunState | null = null;
      if (hasTools) {
        // follow-up 매칭: pending tool-call의 result가 prompt에 있는지 확인
        if (runState && runState.pendingToolCalls.length > 0) {
          const toolResults = extractToolResultsFromHistory(options.prompt);
          const resultIds = new Set(toolResults.map((r) => r.callId));
          if (runState.pendingToolCalls.every((p) => resultIds.has(p.callId))) {
            // 같은 run의 follow-up — tool result append (fetch 전에)
            rs = runState;
            if (rs.lastTurnEndTime) {
              const completedById = new Map(toolResults.map((tc) => [tc.callId, tc]));
              const matched = rs.pendingToolCalls.filter((p) => completedById.has(p.callId));
              const perToolDuration = Math.round(
                (Date.now() - rs.lastTurnEndTime) / matched.length,
              );
              for (const pending of matched) {
                const tc = completedById.get(pending.callId)!;
                rs.pendingSteps.push(
                  appendStep(serverUrl, {
                    requestLogId: rs.requestLogId,
                    stepIndex: pending.stepIndex,
                    type: "tool_call",
                    toolCallIndex: pending.toolCallIndex,
                    toolCallId: pending.callId,
                    toolName: pending.toolName,
                    toolArgs: pending.args,
                    toolResult: tc.result,
                    toolDurationMs: perToolDuration,
                  }).catch(() => {}),
                );
              }
              const matchedIds = new Set(matched.map((p) => p.callId));
              rs.pendingToolCalls = rs.pendingToolCalls.filter((p) => !matchedIds.has(p.callId));
            }
            const next = filterHistoryForStorage(history);
            if (next) rs.history = next;
          }
        }

        if (!rs) {
          // overlap이면 기존 run 종료
          if (runState) {
            console.warn("[qgrid] overlapping call detected, finalizing previous run");
            await finalizeRun({
              status: "error",
              errorMessage: "overlapping call on same qgrid instance",
            });
          }
          // 새 run 생성
          try {
            const run = await createRun(serverUrl, {
              userPrompt: prompt,
              systemPrompt: system,
              modelName: modelId,
              effort: effectiveEffort,
            });
            runState = {
              requestLogId: run.requestLogId,
              stepIndex: 0,
              pendingSteps: [],
              startTime: Date.now(),
              aggUsage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
              history: filterHistoryForStorage(history),
              pendingToolCalls: [],
            };
            rs = runState;
          } catch (e) {
            console.warn(`[qgrid] createRun failed: ${(e as Error).message}`);
          }
        }
      }

      // --- qgrid 서버 호출 ---
      let data: QueryOutput;
      try {
        const res = await fetch(`${serverUrl}/api/qgrid/query`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            args: {
              prompt,
              model: modelId,
              system,
              effort: effectiveEffort,
              ...(verbosity ? { verbosity } : {}),
              ...(reasoningSummary ? { reasoningSummary } : {}),
              ...(serviceTier ? { serviceTier } : {}),
              ...(hasTools ? { tools: tools.map(toQgridTool), isStep: true } : {}),
              ...(history.length > 0 ? { history: JSON.stringify(history) } : {}),
            },
          }),
          signal: options.abortSignal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`qgrid ${res.status}: ${text}`);
        }
        data = (await res.json()) as QueryOutput;
      } catch (e) {
        if (rs && runState === rs) {
          const isAbort =
            options.abortSignal?.aborted || (e as { name?: string }).name === "AbortError";
          await finalizeRun({
            status: isAbort ? "aborted" : "error",
            errorMessage: (e as Error).message,
          });
        }
        throw e;
      }

      // --- 응답 변환 ---
      const content: LanguageModelV3Content[] = [];
      let finishReason: LanguageModelV3FinishReason = { unified: "stop", raw: "stop" };
      if (data.content) {
        for (const item of data.content) {
          if (item.type === "text") content.push({ type: "text", text: item.text });
          else
            content.push({
              type: "tool-call",
              toolCallId: item.toolCallId,
              toolName: item.toolName,
              input: item.input,
            });
        }
        if (data.finishReason === "tool-calls")
          finishReason = { unified: "tool-calls", raw: "tool_call" };
      } else {
        content.push({ type: "text", text: data.text });
      }

      // --- run 기록 ---
      if (rs && runState === rs) {
        rs.aggUsage.input += data.usage.input_tokens;
        rs.aggUsage.output += data.usage.output_tokens;
        rs.aggUsage.cacheRead += data.usage.cache_read_input_tokens;
        rs.aggUsage.cacheCreation += data.usage.cache_creation_input_tokens;
        rs.tokenName = data.tokenName;
        rs.model = data.model;

        const currentStepIndex = rs.stepIndex;
        rs.pendingSteps.push(
          appendStep(serverUrl, {
            requestLogId: rs.requestLogId,
            stepIndex: currentStepIndex,
            type: "generate",
            inputTokens: data.usage.input_tokens,
            outputTokens: data.usage.output_tokens,
            cacheReadTokens: data.usage.cache_read_input_tokens,
            cacheCreationTokens: data.usage.cache_creation_input_tokens,
            durationMs: data.durationMs,
            finishReason: data.finishReason ?? "stop",
          }).catch(() => {}),
        );
        rs.stepIndex++;

        if (finishReason.unified === "tool-calls") {
          rs.lastTurnEndTime = Date.now();
          rs.pendingToolCalls = content
            .filter(
              (c): c is Extract<LanguageModelV3Content, { type: "tool-call" }> =>
                c.type === "tool-call",
            )
            .map((tc, i) => ({
              stepIndex: currentStepIndex,
              toolCallIndex: i,
              callId: tc.toolCallId,
              toolName: tc.toolName,
              args: typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input),
            }));
          if (staleTimer) clearTimeout(staleTimer);
          staleTimer = setTimeout(() => {
            void finalizeRun({
              status: "error",
              errorMessage: "qgrid tool-call run: no follow-up within 30 minutes",
            });
          }, STALE_RUN_TIMEOUT_MS);
          staleTimer.unref?.();
        }

        if (finishReason.unified === "stop") {
          const responseText = content
            .filter(
              (c): c is Extract<LanguageModelV3Content, { type: "text" }> => c.type === "text",
            )
            .map((c) => c.text)
            .join("\n");
          await finalizeRun({ status: "succeeded", response: responseText });
        }
      }

      return {
        content,
        finishReason,
        usage: {
          inputTokens: {
            total: data.usage.input_tokens,
            noCache: data.usage.input_tokens - data.usage.cache_read_input_tokens,
            cacheRead: data.usage.cache_read_input_tokens,
            cacheWrite: data.usage.cache_creation_input_tokens,
          },
          outputTokens: {
            total: data.usage.output_tokens,
            text: data.usage.output_tokens,
            reasoning: undefined,
          },
        },
        warnings: [],
        providerMetadata: {
          qgrid: {
            model: data.model,
            tokenName: data.tokenName ?? null,
            durationMs: data.durationMs,
            costUsd: data.costUsd,
          },
        },
        response: { modelId: data.model },
      };
    },

    async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
      const tools = options.tools?.filter(
        (t): t is LanguageModelV3FunctionTool => t.type === "function",
      );
      const hasTools = tools && tools.length > 0;
      const { prompt, system, history } = extractPromptAndHistory(options.prompt);

      const openaiOpts = options.providerOptions?.openai as Record<string, unknown> | undefined;
      const effectiveEffort = (openaiOpts?.reasoningEffort as string) ?? effort;
      const verbosity = (openaiOpts?.textVerbosity ?? openaiOpts?.verbosity) as string | undefined;
      const reasoningSummary = openaiOpts?.reasoningSummary as string | undefined;
      const serviceTier = openaiOpts?.serviceTier as string | undefined;

      // --- run state 결정 (doStream은 항상 logging) ---
      let rs: RunState | null = null;
      if (runState && runState.pendingToolCalls.length > 0) {
        const toolResults = extractToolResultsFromHistory(options.prompt);
        const resultIds = new Set(toolResults.map((r) => r.callId));
        if (runState.pendingToolCalls.every((p) => resultIds.has(p.callId))) {
          rs = runState;
          if (rs.lastTurnEndTime) {
            const completedById = new Map(toolResults.map((tc) => [tc.callId, tc]));
            const matched = rs.pendingToolCalls.filter((p) => completedById.has(p.callId));
            const perToolDuration = Math.round((Date.now() - rs.lastTurnEndTime) / matched.length);
            for (const pending of matched) {
              const tc = completedById.get(pending.callId)!;
              rs.pendingSteps.push(
                appendStep(serverUrl, {
                  requestLogId: rs.requestLogId,
                  stepIndex: pending.stepIndex,
                  type: "tool_call",
                  toolCallIndex: pending.toolCallIndex,
                  toolCallId: pending.callId,
                  toolName: pending.toolName,
                  toolArgs: pending.args,
                  toolResult: tc.result,
                  toolDurationMs: perToolDuration,
                }).catch(() => {}),
              );
            }
            const matchedIds = new Set(matched.map((p) => p.callId));
            rs.pendingToolCalls = rs.pendingToolCalls.filter((p) => !matchedIds.has(p.callId));
          }
          const next = filterHistoryForStorage(history);
          if (next) rs.history = next;
        }
      }

      if (!rs) {
        if (runState) {
          console.warn("[qgrid] overlapping call detected, finalizing previous run");
          await finalizeRun({
            status: "error",
            errorMessage: "overlapping call on same qgrid instance",
          });
        }
        try {
          const run = await createRun(serverUrl, {
            userPrompt: prompt,
            systemPrompt: system,
            modelName: modelId,
            effort: effectiveEffort,
          });
          runState = {
            requestLogId: run.requestLogId,
            stepIndex: 0,
            pendingSteps: [],
            startTime: Date.now(),
            aggUsage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
            history: filterHistoryForStorage(history),
            pendingToolCalls: [],
          };
          rs = runState;
        } catch (e) {
          console.warn(`[qgrid] createRun failed: ${(e as Error).message}`);
        }
      }

      // --- qgrid 서버 호출 (prepareStream + queryStream) ---
      let sseBody: ReadableStream<Uint8Array>;
      try {
        const prepRes = await fetch(`${serverUrl}/api/qgrid/prepareStream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            args: {
              prompt,
              model: modelId,
              system,
              effort: effectiveEffort,
              ...(verbosity ? { verbosity } : {}),
              ...(reasoningSummary ? { reasoningSummary } : {}),
              ...(serviceTier ? { serviceTier } : {}),
              ...(hasTools ? { tools: tools.map(toQgridTool) } : {}),
              isStep: true,
              ...(history.length > 0 ? { history: JSON.stringify(history) } : {}),
            },
          }),
          signal: options.abortSignal,
        });
        if (!prepRes.ok) {
          const text = await prepRes.text().catch(() => "");
          throw new Error(`qgrid prepareStream ${prepRes.status}: ${text}`);
        }
        const { streamId } = (await prepRes.json()) as { streamId: string };

        const streamRes = await fetch(`${serverUrl}/api/qgrid/queryStream?streamId=${streamId}`, {
          signal: options.abortSignal,
        });
        if (!streamRes.ok || !streamRes.body) {
          const text = await streamRes.text().catch(() => "");
          throw new Error(`qgrid stream ${streamRes.status}: ${text}`);
        }
        sseBody = streamRes.body;
      } catch (e) {
        if (rs && runState === rs) {
          const isAbort =
            options.abortSignal?.aborted || (e as { name?: string }).name === "AbortError";
          await finalizeRun({
            status: isAbort ? "aborted" : "error",
            errorMessage: (e as Error).message,
          });
        }
        throw e;
      }

      // --- SSE stream 변환 ---
      const textId = `text_${Math.random().toString(36).slice(2, 10)}`;
      let textStarted = false;
      let deltaTextEmitted = false;

      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        async start(controller) {
          try {
            let streamCompleted = false;
            for await (const event of parseSSE(sseBody)) {
              if (event.type === "delta") {
                if (!hasTools) {
                  if (!textStarted) {
                    controller.enqueue({ type: "text-start", id: textId });
                    textStarted = true;
                  }
                  controller.enqueue({
                    type: "text-delta",
                    id: textId,
                    delta: (event.data as { text: string }).text,
                  });
                  deltaTextEmitted = true;
                }
              } else if (event.type === "done") {
                if (textStarted) {
                  controller.enqueue({ type: "text-end", id: textId });
                  textStarted = false;
                }
                const done = event.data as QueryOutput;

                // run 기록
                if (rs && runState === rs) {
                  rs.aggUsage.input += done.usage.input_tokens;
                  rs.aggUsage.output += done.usage.output_tokens;
                  rs.aggUsage.cacheRead += done.usage.cache_read_input_tokens;
                  rs.aggUsage.cacheCreation += done.usage.cache_creation_input_tokens;
                  rs.tokenName = done.tokenName;
                  rs.model = done.model;

                  const currentStepIndex = rs.stepIndex;
                  rs.pendingSteps.push(
                    appendStep(serverUrl, {
                      requestLogId: rs.requestLogId,
                      stepIndex: currentStepIndex,
                      type: "generate",
                      inputTokens: done.usage.input_tokens,
                      outputTokens: done.usage.output_tokens,
                      cacheReadTokens: done.usage.cache_read_input_tokens,
                      cacheCreationTokens: done.usage.cache_creation_input_tokens,
                      durationMs: done.durationMs,
                      finishReason: done.finishReason ?? "stop",
                    }).catch(() => {}),
                  );
                  rs.stepIndex++;

                  if (done.finishReason === "tool-calls") {
                    rs.lastTurnEndTime = Date.now();
                    rs.pendingToolCalls = (done.content ?? [])
                      .filter(
                        (
                          item,
                        ): item is Extract<
                          NonNullable<QueryOutput["content"]>[number],
                          { type: "tool-call" }
                        > => item.type === "tool-call",
                      )
                      .map((tc, i) => ({
                        stepIndex: currentStepIndex,
                        toolCallIndex: i,
                        callId: tc.toolCallId,
                        toolName: tc.toolName,
                        args: tc.input,
                      }));
                    if (staleTimer) clearTimeout(staleTimer);
                    staleTimer = setTimeout(() => {
                      void finalizeRun({
                        status: "error",
                        errorMessage: "qgrid tool-call run: no follow-up within 30 minutes",
                      });
                    }, STALE_RUN_TIMEOUT_MS);
                    staleTimer.unref?.();
                  }

                  if (done.finishReason === "stop" || !done.finishReason) {
                    await finalizeRun({ status: "succeeded", response: done.text });
                  }
                }

                // AI SDK stream parts emit
                if (done.content) {
                  for (const item of done.content) {
                    if (item.type === "text" && !deltaTextEmitted) {
                      const tid = `text_${Math.random().toString(36).slice(2, 10)}`;
                      controller.enqueue({ type: "text-start", id: tid });
                      controller.enqueue({ type: "text-delta", id: tid, delta: item.text });
                      controller.enqueue({ type: "text-end", id: tid });
                    } else if (item.type === "tool-call") {
                      controller.enqueue({
                        type: "tool-input-start",
                        id: item.toolCallId,
                        toolName: item.toolName,
                      });
                      controller.enqueue({
                        type: "tool-input-delta",
                        id: item.toolCallId,
                        delta: item.input,
                      });
                      controller.enqueue({ type: "tool-input-end", id: item.toolCallId });
                      controller.enqueue({
                        type: "tool-call",
                        toolCallId: item.toolCallId,
                        toolName: item.toolName,
                        input: item.input,
                      });
                    }
                  }
                }

                controller.enqueue({
                  type: "finish",
                  finishReason:
                    done.finishReason === "tool-calls"
                      ? { unified: "tool-calls", raw: "tool_call" }
                      : { unified: "stop", raw: "stop" },
                  usage: {
                    inputTokens: {
                      total: done.usage.input_tokens,
                      noCache: done.usage.input_tokens - done.usage.cache_read_input_tokens,
                      cacheRead: done.usage.cache_read_input_tokens,
                      cacheWrite: done.usage.cache_creation_input_tokens,
                    },
                    outputTokens: {
                      total: done.usage.output_tokens,
                      text: done.usage.output_tokens,
                      reasoning: undefined,
                    },
                  },
                });
                streamCompleted = true;
                controller.close();
                return;
              } else if (event.type === "error") {
                const errorMsg = (event.data as { message: string }).message;
                streamCompleted = true;
                if (rs && runState === rs)
                  await finalizeRun({ status: "error", errorMessage: errorMsg });
                controller.error(new Error(errorMsg));
                return;
              }
            }
            if (!streamCompleted) {
              if (rs && runState === rs)
                await finalizeRun({
                  status: "error",
                  errorMessage: "stream ended before done event",
                });
              controller.error(new Error("qgrid stream ended unexpectedly"));
            } else {
              controller.close();
            }
          } catch (e) {
            if (rs && runState === rs) {
              const isAbort =
                options.abortSignal?.aborted || (e as { name?: string }).name === "AbortError";
              await finalizeRun({
                status: isAbort ? "aborted" : "error",
                errorMessage: (e as Error).message,
              });
            }
            controller.error(e);
          }
        },
      });

      return { stream };
    },
  };
}

export { createQgridLogger } from "./logger";
export type { QgridLoggerConfig, QgridProviderOptions } from "./index.types";
export default qgrid;
