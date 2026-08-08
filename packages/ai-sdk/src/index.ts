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

import { createEnvelopeStreamParser } from "./envelope-stream-parser";
import {
  type QgridSupportedModel,
  type QueryOutput,
  type QgridProviderConfig,
  type QgridProviderOptions,
  type QgridThreadCoord,
} from "./index.types";
import {
  DEFAULT_QGRID_EFFORT,
  DEFAULT_QGRID_SERVER_URL,
  PENDING_TOOL_RESULTS_WARNING,
  QGRID_PROVIDER_NAME,
  TEXT_STREAM_ID_PREFIX,
  THREAD_COORD_TTL_MS,
  TOP_LEVEL_SCHEMA_WARNING,
} from "./qgrid.constant";
import {
  extractPromptAndHistory,
  extractToolResultsFromHistory,
  parseSSE,
  toQgridTool,
} from "./utils";

// sessionKey → threadCoord(thread 좌표)
// 클라이언트가 전달한 providerOptions.qgrid.sessionKey의 좌표 발급/보관/회송을 여기서 처리한다
// 모듈 레벨이라 qgrid() 인스턴스를 매 호출 새로 만들어도 공유
const threadCoordStore = new Map<string, { coord: QgridThreadCoord; expiresAt: number }>();
const MAX_IMAGE_INPUT_DATA_URL_CHARS = 9_000_000;
const MAX_IMAGE_INPUT_DATA_URL_CHARS_LABEL = "9M";

function assertImageInputFitsJsonTransport(imageUrls: string[]): void {
  let totalDataUrlChars = 0;
  for (const url of imageUrls) {
    if (!url.toLowerCase().startsWith("data:")) continue;
    totalDataUrlChars += url.length;
    if (url.length > MAX_IMAGE_INPUT_DATA_URL_CHARS) {
      throw new Error(
        `qgrid: image input is too large for JSON transport (${url.length} chars). Compress or resize it before passing it to imageGeneration, for example as WebP/JPEG under ${MAX_IMAGE_INPUT_DATA_URL_CHARS_LABEL} total base64 data-url chars.`,
      );
    }
  }
  if (totalDataUrlChars > MAX_IMAGE_INPUT_DATA_URL_CHARS) {
    throw new Error(
      `qgrid: image inputs are too large for JSON transport (${totalDataUrlChars} total chars). Compress or resize them before passing them to imageGeneration, for example as WebP/JPEG under ${MAX_IMAGE_INPUT_DATA_URL_CHARS_LABEL} total base64 data-url chars.`,
    );
  }
}

function warnDroppedImages(droppedImageCount: number): void {
  if (droppedImageCount <= 0) return;
  console.warn(
    `[qgrid] ${droppedImageCount} image message part(s) were ignored because providerOptions.qgrid.imageGeneration is not enabled.`,
  );
}

function serializeObjectResponseFormat(
  responseFormat: LanguageModelV3CallOptions["responseFormat"],
): string | undefined {
  const rawSchema = responseFormat?.type === "json" ? responseFormat.schema : undefined;
  if (rawSchema === undefined) return undefined;

  const schemaType = (rawSchema as { type?: string }).type;
  if (schemaType !== "object") {
    console.warn(
      `[qgrid] responseFormat.schema top-level type is "${schemaType ?? "unknown"}". ${TOP_LEVEL_SCHEMA_WARNING}`,
    );
    return undefined;
  }
  return JSON.stringify(rawSchema);
}

function getThreadCoord(sessionKey: string): QgridThreadCoord | undefined {
  const entry = threadCoordStore.get(sessionKey);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    threadCoordStore.delete(sessionKey);
    return undefined;
  }
  return entry.coord;
}

function setThreadCoord(sessionKey: string, coord: QgridThreadCoord): void {
  threadCoordStore.set(sessionKey, { coord, expiresAt: Date.now() + THREAD_COORD_TTL_MS });
}

function qgridProviderMetadata(data: QueryOutput) {
  return {
    qgrid: {
      model: data.model,
      requestedModel: data.requestedModel ?? data.model,
      modelFallbacks: data.modelFallbacks ?? [],
      tokenName: data.tokenName ?? null,
      durationMs: data.durationMs,
      costUsd: data.costUsd,
      costSource: data.costSource,
      cacheCreation5mInputTokens: data.usage.cache_creation_5m_input_tokens ?? null,
      cacheCreation1hInputTokens: data.usage.cache_creation_1h_input_tokens ?? null,
    },
  };
}

function reusableSessionKey(modelId: QgridSupportedModel, sessionKey?: string): string | undefined {
  return modelId.startsWith("anthropic/") ? undefined : sessionKey;
}

function getQgridProviderOptions(options: LanguageModelV3CallOptions): QgridProviderOptions {
  return (options.providerOptions?.qgrid as QgridProviderOptions | undefined) ?? {};
}

function toAiSdkUsage(usage: QueryOutput["usage"]) {
  const cacheRead = usage.cache_read_input_tokens;
  const cacheWrite = usage.cache_creation_input_tokens;
  return {
    inputTokens: {
      total: usage.input_tokens,
      noCache: Math.max(usage.input_tokens - cacheRead - cacheWrite, 0),
      cacheRead,
      cacheWrite,
    },
    outputTokens: {
      total: usage.output_tokens,
      text: usage.output_tokens,
      reasoning: undefined,
    },
  };
}

export function qgrid(modelId: QgridSupportedModel, config?: QgridProviderConfig): LanguageModelV3 {
  const serverUrl = config?.serverUrl ?? process.env.QGRID_URL ?? DEFAULT_QGRID_SERVER_URL;
  const effort = config?.defaultEffort ?? DEFAULT_QGRID_EFFORT;
  const projectName = config?.projectName ?? process.env.QGRID_PROJECT_NAME;

  type ClientRunContext = NonNullable<QueryOutput["runContext"]>;
  type ClientRunState = {
    runContext?: ClientRunContext;
    pendingToolCallIds: Set<string>;
  };
  type MatchedClientRun = {
    key: string;
    runContext?: ClientRunContext;
    toolResultsPayload: Array<{ toolCallId: string; output: string; isError?: boolean }>;
  };

  const clientRuns = new Map<string, ClientRunState>();
  let anonymousClientRunId = 0;

  function clientRunKey(runContext?: ClientRunContext): string {
    if (runContext?.requestLogId !== undefined) return `request:${runContext.requestLogId}`;
    if (runContext?.threadCoord) {
      const { workerId, epoch, threadId } = runContext.threadCoord;
      return `thread:${workerId}:${epoch}:${threadId}`;
    }
    anonymousClientRunId++;
    return `anonymous:${anonymousClientRunId}`;
  }

  function rememberClientRun(runContext: ClientRunContext | undefined, toolCallIds: string[]) {
    if (toolCallIds.length === 0) return;
    clientRuns.set(clientRunKey(runContext), {
      runContext,
      pendingToolCallIds: new Set(toolCallIds),
    });
  }

  function matchClientRun(messages: LanguageModelV3CallOptions["prompt"]): MatchedClientRun | null {
    const toolResults = extractToolResultsFromHistory(messages);
    if (toolResults.length === 0) return null;

    const resultIds = new Set(toolResults.map((r) => r.callId));
    for (const [key, run] of clientRuns) {
      if (
        run.pendingToolCallIds.size > 0 &&
        [...run.pendingToolCallIds].every((id) => resultIds.has(id))
      ) {
        return {
          key,
          runContext: run.runContext,
          toolResultsPayload: toolResults
            .filter((r) => run.pendingToolCallIds.has(r.callId))
            .map((r) => ({ toolCallId: r.callId, output: r.result })),
        };
      }
    }

    if (clientRuns.size > 0) console.warn(PENDING_TOOL_RESULTS_WARNING);
    return null;
  }

  return {
    specificationVersion: "v3",
    provider: QGRID_PROVIDER_NAME,
    modelId,
    supportedUrls: {},

    async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
      const tools = options.tools?.filter(
        (t): t is LanguageModelV3FunctionTool => t.type === "function",
      );
      const hasTools = tools && tools.length > 0;
      const qgridOptions = getQgridProviderOptions(options);
      const imageGeneration = qgridOptions.imageGeneration;
      const { prompt, system, history, input, imageUrls, droppedImageCount } =
        extractPromptAndHistory(options.prompt, { includeImages: imageGeneration === true });
      if (!imageGeneration) warnDroppedImages(droppedImageCount);
      const effectiveEffort = qgridOptions.effort ?? effort;
      const verbosity = qgridOptions.verbosity;
      const reasoningSummary = qgridOptions.reasoningSummary;
      const serviceTier = qgridOptions.serviceTier;
      const timeoutMs = qgridOptions.timeoutMs;
      const logger = qgridOptions.logger;
      const imageGenerationOptions = qgridOptions.imageGenerationOptions;
      if (imageGeneration) {
        assertImageInputFitsJsonTransport(imageUrls);
      }
      // 멀티턴 대화 식별자. 호출자가 자기 도메인 ID(예: 게임 세션 ID)만 넘기면,
      // thread 좌표 보관/회송은 threadCoordStore 가 내부에서 처리한다 → 클라이언트 무부담.
      const sessionKey = qgridOptions.sessionKey;
      const reuseSessionKey = reusableSessionKey(modelId, sessionKey);

      // qgrid server는 object root schema만 받는다. tools 유무와 무관하게 같은 계약을 적용한다.
      const jsonSchema = serializeObjectResponseFormat(options.responseFormat);

      // follow-up 판단 + toolResults 구성
      let runContext: ClientRunContext | undefined;
      let toolResultsPayload:
        | Array<{ toolCallId: string; output: string; isError?: boolean }>
        | undefined;

      const matchedClientRun = matchClientRun(options.prompt);
      if (matchedClientRun) {
        // follow-up (tool-call 루프)
        runContext = matchedClientRun.runContext;
        toolResultsPayload = matchedClientRun.toolResultsPayload;
      }

      // 비-tool 멀티턴: sessionKey 로 저장된 좌표를 회송.
      // locally matched tool-result follow-up에는 stale session 좌표를 새로 섞지 않는다.
      const storedCoord = reuseSessionKey ? getThreadCoord(reuseSessionKey) : undefined;
      if (!matchedClientRun && storedCoord) {
        runContext = { threadCoord: storedCoord };
      }

      const data = await fetch(`${serverUrl}/api/qgrid/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          args: {
            prompt,
            ...(imageGeneration && input ? { input } : {}),
            model: modelId,
            system,
            effort: effectiveEffort,
            ...(verbosity ? { verbosity } : {}),
            ...(reasoningSummary ? { reasoningSummary } : {}),
            ...(serviceTier ? { serviceTier } : {}),
            ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
            ...(hasTools ? { tools: tools.map(toQgridTool) } : {}),
            ...(jsonSchema ? { jsonSchema } : {}),
            ...(history.length > 0 ? { history: JSON.stringify(history) } : {}),
            ...(projectName ? { projectName } : {}),
            ...(logger === false ? { logger: false } : {}),
            ...(runContext ? { runContext } : {}),
            ...(toolResultsPayload ? { toolResults: toolResultsPayload } : {}),
            ...(imageGeneration ? { imageGeneration } : {}),
            ...(imageGenerationOptions ? { imageGenerationOptions } : {}),
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
          // 명시 분기: 미지의 variant 를 tool-call 로 오인하지 않는다.
          if (item.type === "text") {
            content.push({ type: "text", text: item.text });
          } else if (item.type === "image") {
            // qgrid raw image parts are base64-only; AI SDK file parts require a mediaType.
            content.push({ type: "file", mediaType: "image/png", data: item.data });
          } else if (item.type === "tool-call") {
            content.push({
              type: "tool-call",
              toolCallId: item.toolCallId,
              toolName: item.toolName,
              input: item.input,
            });
          }
        }
        if (data.finishReason === "tool-calls")
          finishReason = { unified: "tool-calls", raw: "tool_call" };
      } else {
        content.push({ type: "text", text: data.text });
      }

      // version skew 방어: imageGeneration의 최종 응답에 이미지가 없으면(구버전 서버가
      // 플래그를 strip 해 조용히 텍스트만 반환) 명시적 에러. 중간 client tool-call은 계속한다.
      if (
        imageGeneration &&
        finishReason.unified !== "tool-calls" &&
        !content.some((c) => c.type === "file")
      ) {
        throw new Error(
          "qgrid: imageGeneration was requested but the response contained no image — the server may be an older version that does not support image generation.",
        );
      }

      // client run state 업데이트
      if (matchedClientRun) clientRuns.delete(matchedClientRun.key);
      if (finishReason.unified === "tool-calls") {
        rememberClientRun(
          data.runContext,
          content
            .filter(
              (c): c is Extract<LanguageModelV3Content, { type: "tool-call" }> =>
                c.type === "tool-call",
            )
            .map((c) => c.toolCallId),
        );
      }

      // sessionKey 가 있으면 발급된 좌표를 저장 → 다음 호출에 자동 회송 (thread 재사용).
      if (reuseSessionKey && data.runContext?.threadCoord) {
        setThreadCoord(reuseSessionKey, data.runContext.threadCoord);
      }

      return {
        content,
        finishReason,
        usage: toAiSdkUsage(data.usage),
        warnings: [],
        providerMetadata: qgridProviderMetadata(data),
        response: { modelId: data.model },
      };
    },

    async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
      const tools = options.tools?.filter(
        (t): t is LanguageModelV3FunctionTool => t.type === "function",
      );
      const hasTools = tools && tools.length > 0;
      const qgridOptions = getQgridProviderOptions(options);
      const effectiveEffort = qgridOptions.effort ?? effort;
      const verbosity = qgridOptions.verbosity;
      const reasoningSummary = qgridOptions.reasoningSummary;
      const serviceTier = qgridOptions.serviceTier;
      const timeoutMs = qgridOptions.timeoutMs;
      const logger = qgridOptions.logger;
      // 이미지 생성은 non-stream 전용(R2). 서버 왕복 전에 클라이언트에서 명시적으로 거부한다.
      if (qgridOptions.imageGeneration) {
        throw new Error(
          "qgrid: imageGeneration is not supported with streamText — use generateText instead.",
        );
      }
      const { prompt, system, history, droppedImageCount } = extractPromptAndHistory(
        options.prompt,
        { includeImages: false },
      );
      warnDroppedImages(droppedImageCount);
      const sessionKey = qgridOptions.sessionKey;
      const reuseSessionKey = reusableSessionKey(modelId, sessionKey);

      const jsonSchema = serializeObjectResponseFormat(options.responseFormat);

      // follow-up 판단
      let runContext: ClientRunContext | undefined;
      let toolResultsPayload:
        | Array<{ toolCallId: string; output: string; isError?: boolean }>
        | undefined;

      const matchedClientRun = matchClientRun(options.prompt);
      if (matchedClientRun) {
        runContext = matchedClientRun.runContext;
        toolResultsPayload = matchedClientRun.toolResultsPayload;
      }

      // 비-tool 멀티턴: sessionKey 로 저장된 좌표를 회송. locally matched tool
      // follow-up에는 stale session 좌표를 새로 섞지 않는다.
      const storedCoord = reuseSessionKey ? getThreadCoord(reuseSessionKey) : undefined;
      if (!matchedClientRun && storedCoord) {
        runContext = { threadCoord: storedCoord };
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
            ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
            ...(hasTools ? { tools: tools.map(toQgridTool) } : {}),
            ...(jsonSchema ? { jsonSchema } : {}),
            ...(history.length > 0 ? { history: JSON.stringify(history) } : {}),
            ...(projectName ? { projectName } : {}),
            ...(logger === false ? { logger: false } : {}),
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

      const textId = `${TEXT_STREAM_ID_PREFIX}_${Math.random().toString(36).slice(2, 10)}`;
      let textStarted = false;
      let deltaTextEmitted = false;

      // 툴이 있으면 델타는 봉투 JSON 원문이다. 증분 파싱해 action:"answer" 로
      // 판명되는 순간부터 answer 값만 재방출한다 (SON-527). tool_call 이거나
      // 미판명 구간이면 파서가 "" 를 돌려줘 기존처럼 보류된다.
      const envelopeParser = hasTools
        ? createEnvelopeStreamParser(jsonSchema ? "json" : "text")
        : undefined;

      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        async start(controller) {
          try {
            let streamCompleted = false;
            for await (const event of parseSSE(streamRes.body!)) {
              if (event.type === "delta") {
                const raw = (event.data as { text: string }).text;
                const text = envelopeParser ? envelopeParser.push(raw) : raw;
                if (text !== "") {
                  if (!textStarted) {
                    controller.enqueue({ type: "text-start", id: textId });
                    textStarted = true;
                  }
                  controller.enqueue({
                    type: "text-delta",
                    id: textId,
                    delta: text,
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
                if (matchedClientRun) clientRuns.delete(matchedClientRun.key);
                if (done.finishReason === "tool-calls") {
                  rememberClientRun(
                    done.runContext,
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
                  );
                }

                // sessionKey 가 있으면 발급된 좌표를 저장 → 다음 호출에 자동 회송 (thread 재사용).
                if (reuseSessionKey && done.runContext?.threadCoord) {
                  setThreadCoord(reuseSessionKey, done.runContext.threadCoord);
                }

                // AI SDK stream parts
                if (done.content) {
                  for (const item of done.content) {
                    if (item.type === "text" && !deltaTextEmitted) {
                      const tid = `${TEXT_STREAM_ID_PREFIX}_${Math.random()
                        .toString(36)
                        .slice(2, 10)}`;
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
                  type: "response-metadata",
                  modelId: done.model,
                });
                controller.enqueue({
                  type: "finish",
                  finishReason:
                    done.finishReason === "tool-calls"
                      ? { unified: "tool-calls", raw: "tool_call" }
                      : { unified: "stop", raw: "stop" },
                  usage: toAiSdkUsage(done.usage),
                  providerMetadata: qgridProviderMetadata(done),
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
export type { QgridLoggerConfig, QgridProviderOptions, QgridSupportedModel } from "./index.types";
export default qgrid;
