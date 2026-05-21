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
import { type QgridSupportedModel, type QueryOutput, type QgridProviderConfig } from "./index.types";
import {
  createRun,
  appendStep,
  finishRun,
  extractPromptAndHistory,
  extractToolResultsFromHistory,
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
        } catch {}
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

        if (rs.stepIndex > 0) {
          const prevToolCalls = extractToolResultsFromHistory(options.prompt);
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

        if (finishReason.unified === "stop") {
          const responseText = content
            .filter((c): c is Extract<LanguageModelV3Content, { type: "text" }> => c.type === "text")
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
      const result = await model.doGenerate(options);

      const parts: LanguageModelV3StreamPart[] = [];
      for (const item of result.content) {
        if (item.type === "text") {
          const id = `text_${Math.random().toString(36).slice(2, 10)}`;
          parts.push({ type: "text-start", id });
          parts.push({ type: "text-delta", id, delta: item.text });
          parts.push({ type: "text-end", id });
        } else if (item.type === "tool-call") {
          const id = item.toolCallId;
          parts.push({ type: "tool-input-start", id, toolName: item.toolName });
          parts.push({ type: "tool-input-delta", id, delta: item.input });
          parts.push({ type: "tool-input-end", id });
        }
      }

      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          for (const part of parts) {
            controller.enqueue(part);
          }
          controller.close();
        },
      });

      return {
        stream,
        response: result.response,
      };
    },
  };

  return model;
}

export default qgrid;
