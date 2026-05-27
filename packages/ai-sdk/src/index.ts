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

  type ClientRunState = {
    runContext: { requestLogId: number };
    pendingToolCallIds: Set<string>;
  };

  let clientRun: ClientRunState | null = null;

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

      // top-level이 object인지 검사, 아니면 무시 (SDK 방어로직)
      const rawSchema =
        options.responseFormat?.type === "json" ? options.responseFormat.schema : undefined;
      const schemaType = rawSchema ? (rawSchema as { type?: string }).type : undefined;
      if (rawSchema && !hasTools && schemaType !== "object") {
        console.warn(
          `[qgrid] responseFormat.schema top-level type is "${schemaType ?? "unknown"}". OpenAI structured output requires "object". Falling back to client-side parsing.`,
        );
      }
      const jsonSchema =
        !hasTools && rawSchema && schemaType === "object" ? JSON.stringify(rawSchema) : undefined;

      // follow-up 판단 + toolResults 구성
      let runContext: { requestLogId: number } | undefined;
      let toolResultsPayload:
        | Array<{ toolCallId: string; output: string; isError?: boolean }>
        | undefined;
      let logMode: "auto" | "run" | undefined;

      if (clientRun) {
        const toolResults = extractToolResultsFromHistory(options.prompt);
        const resultIds = new Set(toolResults.map((r) => r.callId));
        if (
          clientRun.pendingToolCallIds.size > 0 &&
          [...clientRun.pendingToolCallIds].every((id) => resultIds.has(id))
        ) {
          // follow-up
          runContext = clientRun.runContext;
          toolResultsPayload = toolResults
            .filter((r) => clientRun!.pendingToolCallIds.has(r.callId))
            .map((r) => ({ toolCallId: r.callId, output: r.result }));
          logMode = "run";
        } else {
          console.warn(
            "[qgrid] pending tool results not found in prompt, clearing client run state",
          );
          clientRun = null;
        }
      }

      if (!logMode && hasTools) logMode = "run";

      const data = await fetch(`${serverUrl}/api/qgrid/query`, {
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
            ...(jsonSchema ? { jsonSchema } : {}),
            ...(history.length > 0 ? { history: JSON.stringify(history) } : {}),
            ...(logMode ? { logMode } : {}),
            ...(runContext ? { runContext } : {}),
            ...(toolResultsPayload ? { toolResults: toolResultsPayload } : {}),
          },
        }),
        signal: options.abortSignal,
      }).then(async (res) => {
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`qgrid ${res.status}: ${text}`);
        }
        return (await res.json()) as QueryOutput;
      });

      // 응답 변환
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

      // client run state 업데이트
      if (data.runContext && finishReason.unified === "tool-calls") {
        clientRun = {
          runContext: data.runContext,
          pendingToolCallIds: new Set(
            content
              .filter(
                (c): c is Extract<LanguageModelV3Content, { type: "tool-call" }> =>
                  c.type === "tool-call",
              )
              .map((c) => c.toolCallId),
          ),
        };
      } else {
        clientRun = null;
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

      const rawSchema =
        options.responseFormat?.type === "json" ? options.responseFormat.schema : undefined;
      const jsonSchema =
        !hasTools && rawSchema && (rawSchema as { type?: string }).type === "object"
          ? JSON.stringify(rawSchema)
          : undefined;

      // follow-up 판단
      let runContext: { requestLogId: number } | undefined;
      let toolResultsPayload:
        | Array<{ toolCallId: string; output: string; isError?: boolean }>
        | undefined;

      if (clientRun) {
        const toolResults = extractToolResultsFromHistory(options.prompt);
        const resultIds = new Set(toolResults.map((r) => r.callId));
        if (
          clientRun.pendingToolCallIds.size > 0 &&
          [...clientRun.pendingToolCallIds].every((id) => resultIds.has(id))
        ) {
          runContext = clientRun.runContext;
          toolResultsPayload = toolResults
            .filter((r) => clientRun!.pendingToolCallIds.has(r.callId))
            .map((r) => ({ toolCallId: r.callId, output: r.result }));
        } else {
          console.warn(
            "[qgrid] pending tool results not found in prompt, clearing client run state",
          );
          clientRun = null;
        }
      }

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
            ...(jsonSchema ? { jsonSchema } : {}),
            ...(history.length > 0 ? { history: JSON.stringify(history) } : {}),
            logMode: "run",
            ...(runContext ? { runContext } : {}),
            ...(toolResultsPayload ? { toolResults: toolResultsPayload } : {}),
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

      const textId = `text_${Math.random().toString(36).slice(2, 10)}`;
      let textStarted = false;
      let deltaTextEmitted = false;

      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        async start(controller) {
          try {
            let streamCompleted = false;
            for await (const event of parseSSE(streamRes.body!)) {
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

                // client run state 업데이트
                if (done.runContext && done.finishReason === "tool-calls") {
                  clientRun = {
                    runContext: done.runContext,
                    pendingToolCallIds: new Set(
                      (done.content ?? [])
                        .filter(
                          (
                            c,
                          ): c is Extract<
                            NonNullable<QueryOutput["content"]>[number],
                            { type: "tool-call" }
                          > => c.type === "tool-call",
                        )
                        .map((c) => c.toolCallId),
                    ),
                  };
                } else {
                  clientRun = null;
                }

                // AI SDK stream parts
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
                streamCompleted = true;
                controller.error(new Error((event.data as { message: string }).message));
                return;
              }
            }
            if (!streamCompleted) {
              controller.error(new Error("qgrid stream ended unexpectedly"));
            }
          } catch (e) {
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
