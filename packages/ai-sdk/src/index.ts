/**
 * @cartanova/qgrid-ai-sdk — AI SDK LanguageModelV3 provider for qgrid.
 *
 * Usage:
 *   import { qgrid } from "@cartanova/qgrid-ai-sdk";
 *   const result = await generateText({
 *     model: qgrid("openai/gpt-5.5"),
 *     prompt: "Hello",
 *   });
 */
import {
  type LanguageModelV3,
  type LanguageModelV3CallOptions,
  type LanguageModelV3Content,
  type LanguageModelV3FinishReason,
  type LanguageModelV3FunctionTool,
  type LanguageModelV3GenerateResult,
  type LanguageModelV3StreamPart,
  type LanguageModelV3StreamResult,
  type LanguageModelV3Usage,
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
  parseSSE,
  toQgridTool,
} from "./utils";

const DEFAULT_SERVER_URL = "http://localhost:44900";
const DEFAULT_EFFORT = "low";

export function qgrid(modelId: QgridSupportedModel, config?: QgridProviderConfig): LanguageModelV3 {
  const serverUrl = config?.serverUrl ?? process.env.QGRID_URL ?? DEFAULT_SERVER_URL;
  const effort = config?.defaultEffort ?? DEFAULT_EFFORT;

  let runState: {
    requestLogId: number;
    stepIndex: number;
    pendingSteps: Promise<unknown>[];
    startTime: number;
    aggUsage: { input: number; output: number; cacheRead: number; cacheCreation: number };
    tokenName?: string;
    model?: string;
    lastTurnEndTime?: number;
  } | null = null;

  const model: LanguageModelV3 = {
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

      if (!runState && hasTools) {
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
          };
        } catch (e) {
          console.warn(`[qgrid] createRun failed: ${(e as Error).message}`);
        }
      }

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
            ...(hasTools ? { tools: tools.map(toQgridTool) } : {}),
            ...(hasTools ? { isStep: true } : {}),
            ...(history.length > 0 ? { history: JSON.stringify(history) } : {}),
          },
        }),
        signal: options.abortSignal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const error = new Error(`qgrid ${res.status}: ${text}`);
        if (runState) {
          await Promise.allSettled(runState.pendingSteps);
          await finishRun(serverUrl, {
            requestLogId: runState.requestLogId,
            status: "error",
            errorMessage: error.message,
            totalDurationMs: Date.now() - runState.startTime,
          }).catch(() => {});
          runState = null;
        }
        throw error;
      }

      const data = (await res.json()) as QueryOutput;
      const content: LanguageModelV3Content[] = [];
      let finishReason: LanguageModelV3FinishReason = {
        unified: "stop",
        raw: "stop",
      };
      if (data.content) {
        for (const item of data.content) {
          if (item.type === "text") {
            content.push({ type: "text", text: item.text });
          } else {
            content.push({
              type: "tool-call",
              toolCallId: item.toolCallId,
              toolName: item.toolName,
              input: item.input,
            });
          }
        }
        if (data.finishReason === "tool-calls") {
          finishReason = { unified: "tool-calls", raw: "tool_call" };
        }
      } else {
        content.push({ type: "text", text: data.text });
      }

      if (runState) {
        const rs = runState;
        rs.aggUsage.input += data.usage.input_tokens;
        rs.aggUsage.output += data.usage.output_tokens;
        rs.aggUsage.cacheRead += data.usage.cache_read_input_tokens;
        rs.aggUsage.cacheCreation += data.usage.cache_creation_input_tokens;
        rs.tokenName = data.tokenName;
        rs.model = data.model;

        if (rs.stepIndex > 0 && rs.lastTurnEndTime) {
          const prevToolCalls = extractToolResultsFromHistory(options.prompt);
          const totalToolDuration = Date.now() - rs.lastTurnEndTime;
          const perToolDuration =
            prevToolCalls.length > 0 ? Math.round(totalToolDuration / prevToolCalls.length) : 0;
          for (let i = 0; i < prevToolCalls.length; i++) {
            const tc = prevToolCalls[i];
            rs.pendingSteps.push(
              appendStep(serverUrl, {
                requestLogId: rs.requestLogId,
                stepIndex: rs.stepIndex - 1,
                type: "tool_call",
                toolCallIndex: i,
                toolCallId: tc.callId,
                toolName: tc.toolName,
                toolArgs: tc.args,
                toolResult: tc.result,
                toolDurationMs: perToolDuration,
              }).catch(() => {}),
            );
          }
        }

        rs.pendingSteps.push(
          appendStep(serverUrl, {
            requestLogId: rs.requestLogId,
            stepIndex: rs.stepIndex,
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
        }

        if (finishReason.unified === "stop") {
          const responseText = content
            .filter(
              (c): c is Extract<LanguageModelV3Content, { type: "text" }> => c.type === "text",
            )
            .map((c) => c.text)
            .join("\n");

          await Promise.allSettled(rs.pendingSteps);
          await finishRun(serverUrl, {
            requestLogId: rs.requestLogId,
            status: "succeeded",
            response: responseText,
            tokenName: rs.tokenName,
            totalInputTokens: rs.aggUsage.input,
            totalOutputTokens: rs.aggUsage.output,
            totalCacheReadTokens: rs.aggUsage.cacheRead,
            totalCacheCreationTokens: rs.aggUsage.cacheCreation,
            totalDurationMs: Date.now() - rs.startTime,
          }).catch(() => {});
          runState = null;
        }
      }

      const usage: LanguageModelV3Usage = {
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
      };

      return {
        content,
        finishReason,
        usage,
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

      if (!runState && hasTools) {
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
          };
        } catch (e) {
          console.warn(`[qgrid] createRun failed: ${(e as Error).message}`);
        }
      }

      async function failRun(errorMessage: string) {
        if (runState) {
          await Promise.allSettled(runState.pendingSteps);
          await finishRun(serverUrl, {
            requestLogId: runState.requestLogId,
            status: "error",
            errorMessage,
            totalDurationMs: Date.now() - runState.startTime,
          }).catch(() => {});
          runState = null;
        }
      }

      let res: Response;
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
              ...(hasTools ? { isStep: true } : {}),
              ...(history.length > 0 ? { history: JSON.stringify(history) } : {}),
            },
          }),
        });
        if (!prepRes.ok) {
          const text = await prepRes.text().catch(() => "");
          throw new Error(`qgrid prepareStream ${prepRes.status}: ${text}`);
        }
        const { streamId } = (await prepRes.json()) as { streamId: string };

        res = await fetch(`${serverUrl}/api/qgrid/queryStream?streamId=${streamId}`, {
          signal: options.abortSignal,
        });
        if (!res.ok || !res.body) {
          const text = await res.text().catch(() => "");
          throw new Error(`qgrid stream ${res.status}: ${text}`);
        }
      } catch (e) {
        await failRun((e as Error).message);
        throw e;
      }

      const textId = `text_${Math.random().toString(36).slice(2, 10)}`;
      let textStarted = false;
      let deltaTextEmitted = false;
      const sseBody = res.body;

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

                if (runState) {
                  const rs = runState;
                  rs.aggUsage.input += done.usage.input_tokens;
                  rs.aggUsage.output += done.usage.output_tokens;
                  rs.aggUsage.cacheRead += done.usage.cache_read_input_tokens;
                  rs.aggUsage.cacheCreation += done.usage.cache_creation_input_tokens;
                  rs.tokenName = done.tokenName;
                  rs.model = done.model;

                  if (rs.stepIndex > 0 && rs.lastTurnEndTime) {
                    const prevToolCalls = extractToolResultsFromHistory(options.prompt);
                    const totalToolDuration = Date.now() - rs.lastTurnEndTime;
                    const perToolDuration =
                      prevToolCalls.length > 0
                        ? Math.round(totalToolDuration / prevToolCalls.length)
                        : 0;
                    for (let i = 0; i < prevToolCalls.length; i++) {
                      const ptc = prevToolCalls[i];
                      rs.pendingSteps.push(
                        appendStep(serverUrl, {
                          requestLogId: rs.requestLogId,
                          stepIndex: rs.stepIndex - 1,
                          type: "tool_call",
                          toolCallIndex: i,
                          toolCallId: ptc.callId,
                          toolName: ptc.toolName,
                          toolArgs: ptc.args,
                          toolResult: ptc.result,
                          toolDurationMs: perToolDuration,
                        }).catch(() => {}),
                      );
                    }
                  }

                  rs.pendingSteps.push(
                    appendStep(serverUrl, {
                      requestLogId: rs.requestLogId,
                      stepIndex: rs.stepIndex,
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
                  }

                  const isStop = done.finishReason === "stop" || !done.finishReason;
                  if (isStop) {
                    await Promise.allSettled(rs.pendingSteps);
                    await finishRun(serverUrl, {
                      requestLogId: rs.requestLogId,
                      status: "succeeded",
                      response: done.text,
                      tokenName: rs.tokenName,
                      totalInputTokens: rs.aggUsage.input,
                      totalOutputTokens: rs.aggUsage.output,
                      totalCacheReadTokens: rs.aggUsage.cacheRead,
                      totalCacheCreationTokens: rs.aggUsage.cacheCreation,
                      totalDurationMs: Date.now() - rs.startTime,
                    }).catch(() => {});
                    runState = null;
                  }
                }

                // done.content에서 text/tool-call 파트 emit
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

                const finishReason: LanguageModelV3FinishReason =
                  done.finishReason === "tool-calls"
                    ? { unified: "tool-calls", raw: "tool_call" }
                    : { unified: "stop", raw: "stop" };

                const usage: LanguageModelV3Usage = {
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
                };

                controller.enqueue({ type: "finish", finishReason, usage });
                streamCompleted = true;
                controller.close();
                return;
              } else if (event.type === "error") {
                const errorMsg = (event.data as { message: string }).message;
                streamCompleted = true;
                await failRun(errorMsg);
                controller.error(new Error(errorMsg));
                return;
              }
            }
            if (!streamCompleted) {
              await failRun("stream ended before done event");
              controller.error(new Error("qgrid stream ended unexpectedly"));
            } else {
              controller.close();
            }
          } catch (e) {
            await failRun((e as Error).message);
            controller.error(e);
          }
        },
      });

      return { stream };
    },
  };

  return model;
}

export { createQgridLogger } from "./logger";
export type { QgridLoggerConfig } from "./index.types";
export default qgrid;
