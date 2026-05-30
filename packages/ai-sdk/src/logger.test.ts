import { type TelemetryIntegration } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQgridLogger } from "./logger";

const SERVER = "http://localhost:44900";

function getIntegration(config: Parameters<typeof createQgridLogger>[0]): TelemetryIntegration {
  const settings = createQgridLogger(config);
  const integrations = Array.isArray(settings.integrations)
    ? settings.integrations
    : settings.integrations
      ? [settings.integrations]
      : [];
  return integrations[0];
}

type FetchCall = { url: string; body: { input: Record<string, unknown> } };

function mockFetch() {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as FetchCall["body"];
      calls.push({ url, body });

      if (url.includes("/createRun")) {
        return new Response(JSON.stringify({ requestLogId: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ stepId: 1, ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("createQgridLogger", () => {
  it("logs simple text generation (no tools)", async () => {
    const calls = mockFetch();
    const logger = getIntegration({ serverUrl: SERVER, projectName: "test" });

    await logger.onStart!({
      model: { provider: "google", modelId: "gemini-3-flash" },
      prompt: "Hello",
      system: "You are helpful",
    } as never);

    await logger.onStepFinish!({
      stepNumber: 0,
      finishReason: "stop",
      usage: { inputTokens: 100, outputTokens: 50, inputTokenDetails: {} },
      content: [],
      text: "Hi there",
    } as never);

    await logger.onFinish!({
      finishReason: "stop",
      text: "Hi there",
      totalUsage: { inputTokens: 100, outputTokens: 50, inputTokenDetails: {} },
    } as never);

    const createRunCall = calls.find((c) => c.url.includes("/createRun"));
    expect(createRunCall?.body.input).toMatchObject({
      userPrompt: "Hello",
      systemPrompt: "You are helpful",
      modelName: "gemini-3-flash",
      projectName: "test",
    });

    const appendCalls = calls.filter((c) => c.url.includes("/appendStep"));
    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0].body.input).toMatchObject({
      stepIndex: 0,
      type: "generate",
      finishReason: "stop",
    });

    const finishCall = calls.find((c) => c.url.includes("/finishRun"));
    expect(finishCall?.body.input).toMatchObject({
      requestLogId: 1,
      status: "succeeded",
      response: "Hi there",
      tokenName: "external",
    });
  });

  it("logs tool calling multi-step", async () => {
    const calls = mockFetch();
    const logger = getIntegration({ serverUrl: SERVER });

    await logger.onStart!({
      model: { provider: "google", modelId: "gemini-3-flash" },
      prompt: "Weather in Seoul",
    } as never);

    // tool call finish — durationMs 캐시
    await logger.onToolCallFinish!({
      toolCall: { toolCallId: "call_1", toolName: "getWeather" },
      durationMs: 150,
    } as never);

    // step 0: tool-calls (tool-call만 있고 tool-result는 다음 step에)
    await logger.onStepFinish!({
      stepNumber: 0,
      finishReason: "tool-calls",
      usage: { inputTokens: 200, outputTokens: 30, inputTokenDetails: {} },
      content: [
        {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "getWeather",
          input: { city: "Seoul" },
        },
      ],
    } as never);

    // step 1: stop (이전 step의 tool-result가 여기 content에)
    await logger.onStepFinish!({
      stepNumber: 1,
      finishReason: "stop",
      usage: { inputTokens: 400, outputTokens: 80, inputTokenDetails: {} },
      content: [{ type: "tool-result", toolCallId: "call_1", output: { temperature: 22 } }],
    } as never);

    await logger.onFinish!({
      finishReason: "stop",
      text: "Seoul is 22°C",
      totalUsage: { inputTokens: 600, outputTokens: 110, inputTokenDetails: {} },
    } as never);

    const appendCalls = calls.filter((c) => c.url.includes("/appendStep"));
    expect(appendCalls).toHaveLength(3); // generate + tool_call + generate

    const toolCallStep = appendCalls.find((c) => c.body.input.type === "tool_call");
    expect(toolCallStep?.body.input).toMatchObject({
      toolName: "getWeather",
      toolArgs: '{"city":"Seoul"}',
      toolResult: '{"temperature":22}',
      toolDurationMs: 150,
    });

    const finishCall = calls.find((c) => c.url.includes("/finishRun"));
    expect(finishCall?.body.input).toMatchObject({
      status: "succeeded",
      totalInputTokens: 600,
      totalOutputTokens: 110,
    });
  });

  it("logs step reasoning text and token usage when provided", async () => {
    const calls = mockFetch();
    const logger = getIntegration({ serverUrl: SERVER });

    await logger.onStart!({
      model: { provider: "openai", modelId: "gpt-5.4" },
      prompt: "Think briefly",
    } as never);

    await logger.onStepFinish!({
      stepNumber: 0,
      finishReason: "stop",
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        inputTokenDetails: {},
        outputTokenDetails: { reasoningTokens: 7 },
      },
      reasoningText: "Need a concise answer.",
      content: [],
    } as never);

    await logger.onFinish!({
      finishReason: "stop",
      text: "ok",
      totalUsage: { inputTokens: 10, outputTokens: 20, inputTokenDetails: {} },
    } as never);

    const generateStep = calls.find(
      (c) => c.url.includes("/appendStep") && c.body.input.type === "generate",
    );
    expect(generateStep?.body.input).toMatchObject({
      reasoningText: "Need a concise answer.",
      reasoningTokens: 7,
    });
  });

  it("handles error — finishRun with status error", async () => {
    const calls = mockFetch();
    const logger = getIntegration({ serverUrl: SERVER });

    await logger.onStart!({
      model: { provider: "google", modelId: "gemini-3-flash" },
      prompt: "test",
    } as never);

    await logger.onFinish!({
      finishReason: "error",
      text: "",
      error: new Error("LLM failed"),
      totalUsage: { inputTokens: 50, outputTokens: 0, inputTokenDetails: {} },
    } as never);

    const finishCall = calls.find((c) => c.url.includes("/finishRun"));
    expect(finishCall?.body.input).toMatchObject({
      status: "error",
      errorMessage: "Error: LLM failed",
    });
  });

  it("skips when model.provider is qgrid", async () => {
    const calls = mockFetch();
    const logger = getIntegration({ serverUrl: SERVER });

    await logger.onStart!({
      model: { provider: "qgrid", modelId: "openai/gpt-5.4" },
      prompt: "test",
    } as never);

    await logger.onStepFinish!({
      stepNumber: 0,
      finishReason: "stop",
      usage: { inputTokens: 100, outputTokens: 50 },
      content: [],
    } as never);

    await logger.onFinish!({
      finishReason: "stop",
      text: "response",
      totalUsage: { inputTokens: 100, outputTokens: 50 },
    } as never);

    expect(calls).toHaveLength(0);
  });

  it("skips all hooks when createRun fails", async () => {
    const errors: Error[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("server down");
      }),
    );

    const logger = getIntegration({
      serverUrl: SERVER,
      onLogError: (err) => errors.push(err),
    });

    await logger.onStart!({
      model: { provider: "google", modelId: "gemini-3-flash" },
      prompt: "test",
    } as never);

    await logger.onStepFinish!({
      stepNumber: 0,
      finishReason: "stop",
      usage: { inputTokens: 100, outputTokens: 50 },
      content: [],
    } as never);

    await logger.onFinish!({
      finishReason: "stop",
      text: "response",
      totalUsage: { inputTokens: 100, outputTokens: 50 },
    } as never);

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe("server down");
  });

  it("uses messages array for prompt extraction", async () => {
    const calls = mockFetch();
    const logger = getIntegration({ serverUrl: SERVER });
    const messages = [
      { role: "user", content: [{ type: "text", text: "first message" }] },
      { role: "assistant", content: [{ type: "text", text: "response" }] },
      { role: "user", content: [{ type: "text", text: "second message" }] },
    ];

    await logger.onStart!({
      model: { provider: "anthropic", modelId: "claude-sonnet-4.7" },
      prompt: undefined,
      messages,
    } as never);

    await logger.onFinish!({
      finishReason: "stop",
      text: "done",
      totalUsage: { inputTokens: 10, outputTokens: 5, inputTokenDetails: {} },
    } as never);

    const createRunCall = calls.find((c) => c.url.includes("/createRun"));
    expect(createRunCall?.body.input.userPrompt).toBe("second message");

    // history는 createRun에서 전송됨 (onStart 시점)
    expect(JSON.parse(String(createRunCall?.body.input.history))).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "first message" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "response" }] },
    ]);
  });

  it("filters tool calls and tool results from history (user/assistant only)", async () => {
    const calls = mockFetch();
    const logger = getIntegration({ serverUrl: SERVER });
    const messages = [
      { role: "system", content: "you are helpful" },
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "answer" },
          { type: "tool-call", toolCallId: "call_1", toolName: "getX", input: { id: 1 } },
        ],
      },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call_1", output: "x" }] },
      { role: "user", content: [{ type: "text", text: "follow-up" }] },
    ];

    await logger.onStart!({
      model: { provider: "google", modelId: "gemini-3-flash" },
      messages,
    } as never);

    await logger.onFinish!({
      finishReason: "stop",
      text: "done",
      totalUsage: { inputTokens: 10, outputTokens: 5, inputTokenDetails: {} },
    } as never);

    const createRunCall = calls.find((c) => c.url.includes("/createRun"));
    // history는 createRun에서 전송됨. 마지막 user 메시지(follow-up)는 현재 turn이라 제외. system/tool/function_call 도 제외.
    expect(JSON.parse(String(createRunCall?.body.input.history))).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
    ]);
  });

  it("keeps unmatched pending tool calls until a later step or finish", async () => {
    const calls = mockFetch();
    const logger = getIntegration({ serverUrl: SERVER });

    await logger.onStart!({
      model: { provider: "google", modelId: "gemini-3-flash" },
      prompt: "Weather in Seoul",
    } as never);

    await logger.onStepFinish!({
      stepNumber: 0,
      finishReason: "tool-calls",
      usage: { inputTokens: 200, outputTokens: 30, inputTokenDetails: {} },
      content: [
        {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "getWeather",
          input: { city: "Seoul" },
        },
      ],
    } as never);

    await logger.onStepFinish!({
      stepNumber: 1,
      finishReason: "tool-calls",
      usage: { inputTokens: 250, outputTokens: 20, inputTokenDetails: {} },
      content: [],
    } as never);

    await logger.onFinish!({
      finishReason: "stop",
      text: "done",
      totalUsage: { inputTokens: 450, outputTokens: 50, inputTokenDetails: {} },
    } as never);

    const toolCallStep = calls.find(
      (c) => c.url.includes("/appendStep") && c.body.input.type === "tool_call",
    );
    expect(toolCallStep?.body.input).toMatchObject({
      stepIndex: 0,
      toolName: "getWeather",
      toolArgs: '{"city":"Seoul"}',
    });
  });

  it("separates overlapping runs by metadata qgridRunId", async () => {
    const calls = mockFetch();
    const logger = getIntegration({ serverUrl: SERVER });

    await logger.onStart!({
      model: { provider: "google", modelId: "gemini-3-flash" },
      prompt: "first",
      metadata: { qgridRunId: "run-1" },
    } as never);
    await logger.onStart!({
      model: { provider: "google", modelId: "gemini-3-flash" },
      prompt: "second",
      metadata: { qgridRunId: "run-2" },
    } as never);

    await logger.onFinish!({
      finishReason: "stop",
      text: "first response",
      totalUsage: { inputTokens: 1, outputTokens: 1, inputTokenDetails: {} },
      metadata: { qgridRunId: "run-1" },
    } as never);
    await logger.onFinish!({
      finishReason: "stop",
      text: "second response",
      totalUsage: { inputTokens: 2, outputTokens: 2, inputTokenDetails: {} },
      metadata: { qgridRunId: "run-2" },
    } as never);

    const finishCalls = calls.filter((c) => c.url.includes("/finishRun"));
    expect(finishCalls.map((c) => c.body.input.response)).toEqual([
      "first response",
      "second response",
    ]);
  });

  it("closes the active run and quarantines when telemetry keys overlap", async () => {
    const calls = mockFetch();
    const errors: Error[] = [];
    const logger = getIntegration({
      serverUrl: SERVER,
      onLogError: (err) => errors.push(err),
    });

    await logger.onStart!({
      model: { provider: "google", modelId: "gemini-3-flash" },
      prompt: "first",
    } as never);
    await logger.onStart!({
      model: { provider: "google", modelId: "gemini-3-flash" },
      prompt: "second",
    } as never);

    // 늦게 도착하는 이전 onFinish들 — quarantine 중이므로 무시됨
    await logger.onFinish!({
      finishReason: "stop",
      text: "first response",
      totalUsage: { inputTokens: 1, outputTokens: 1, inputTokenDetails: {} },
    } as never);
    await logger.onFinish!({
      finishReason: "stop",
      text: "second response",
      totalUsage: { inputTokens: 2, outputTokens: 2, inputTokenDetails: {} },
    } as never);

    // overlap된 첫 run만 error finalize됨. 새 run은 생성 안 됨.
    const finishCalls = calls.filter((c) => c.url.includes("/finishRun"));
    expect(finishCalls).toHaveLength(1);
    expect(finishCalls[0].body.input).toMatchObject({
      status: "error",
      errorMessage: expect.stringContaining("overlapping runs"),
    });
    expect(errors[0].message).toContain("overlapping runs");
  });

  it("marks runs as error when onFinish is never emitted", async () => {
    vi.useFakeTimers();
    const calls = mockFetch();
    const logger = getIntegration({ serverUrl: SERVER, staleRunTimeoutMs: 100 });

    await logger.onStart!({
      model: { provider: "google", modelId: "gemini-3-flash" },
      prompt: "test",
    } as never);

    await vi.advanceTimersByTimeAsync(100);

    const finishCall = calls.find((c) => c.url.includes("/finishRun"));
    expect(finishCall?.body.input).toMatchObject({
      status: "error",
      errorMessage: "AI SDK generation ended before onFinish was emitted",
    });
  });

  it("marks runs as aborted when the AI SDK abort signal fires", async () => {
    const calls = mockFetch();
    const abortController = new AbortController();
    const logger = getIntegration({ serverUrl: SERVER, staleRunTimeoutMs: 0 });

    await logger.onStart!({
      model: { provider: "google", modelId: "gemini-3-flash" },
      prompt: "test",
      abortSignal: abortController.signal,
    } as never);

    abortController.abort("user stopped");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const finishCall = calls.find((c) => c.url.includes("/finishRun"));
    expect(finishCall?.body.input).toMatchObject({
      status: "aborted",
      errorMessage: "user stopped",
    });
  });

  it("expires suppressed qgrid runs when their finish event never arrives", async () => {
    vi.useFakeTimers();
    const calls = mockFetch();
    const logger = getIntegration({ serverUrl: SERVER, staleRunTimeoutMs: 100 });

    await logger.onStart!({
      model: { provider: "qgrid", modelId: "openai/gpt-5.4" },
      prompt: "handled by qgrid wrapper",
    } as never);

    await vi.advanceTimersByTimeAsync(100);

    await logger.onStart!({
      model: { provider: "google", modelId: "gemini-3-flash" },
      prompt: "next normal call",
    } as never);
    await logger.onFinish!({
      finishReason: "stop",
      text: "ok",
      totalUsage: { inputTokens: 1, outputTokens: 1, inputTokenDetails: {} },
    } as never);

    const createRunCall = calls.find((c) => c.url.includes("/createRun"));
    expect(createRunCall?.body.input).toMatchObject({
      userPrompt: "next normal call",
    });
  });

  it("uses custom tokenName from config", async () => {
    const calls = mockFetch();
    const logger = getIntegration({ serverUrl: SERVER, tokenName: "...abc1" });

    await logger.onStart!({
      model: { provider: "google", modelId: "gemini-3-flash" },
      prompt: "test",
    } as never);

    await logger.onStepFinish!({
      stepNumber: 0,
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5, inputTokenDetails: {} },
      content: [],
    } as never);

    await logger.onFinish!({
      finishReason: "stop",
      text: "ok",
      totalUsage: { inputTokens: 10, outputTokens: 5, inputTokenDetails: {} },
    } as never);

    const finishCall = calls.find((c) => c.url.includes("/finishRun"));
    expect(finishCall?.body.input.tokenName).toBe("...abc1");
  });
});
