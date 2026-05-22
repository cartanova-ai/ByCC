import { afterEach, describe, expect, it, vi } from "vitest";

import { createQgridLogger } from "./logger";

const SERVER = "http://localhost:44900";

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
  vi.unstubAllGlobals();
});

describe("createQgridLogger", () => {
  it("logs simple text generation (no tools)", async () => {
    const calls = mockFetch();
    const logger = createQgridLogger({ serverUrl: SERVER, projectName: "test" });

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
    const logger = createQgridLogger({ serverUrl: SERVER });

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
        { type: "tool-call", toolCallId: "call_1", toolName: "getWeather", input: { city: "Seoul" } },
      ],
    } as never);

    // step 1: stop (이전 step의 tool-result가 여기 content에)
    await logger.onStepFinish!({
      stepNumber: 1,
      finishReason: "stop",
      usage: { inputTokens: 400, outputTokens: 80, inputTokenDetails: {} },
      content: [
        { type: "tool-result", toolCallId: "call_1", output: { temperature: 22 } },
      ],
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
    const logger = createQgridLogger({ serverUrl: SERVER });

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
    const logger = createQgridLogger({ serverUrl: SERVER });

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
    const logger = createQgridLogger({ serverUrl: SERVER });

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

    const logger = createQgridLogger({
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
    const logger = createQgridLogger({ serverUrl: SERVER });
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

    const finishCall = calls.find((c) => c.url.includes("/finishRun"));
    expect(JSON.parse(String(finishCall?.body.input.history))).toEqual([
      { type: "message", role: "user", content: "first message" },
      { type: "message", role: "assistant", content: "response" },
      { type: "message", role: "user", content: "second message" },
    ]);
  });

  it("filters out tool and system messages from history", async () => {
    const calls = mockFetch();
    const logger = createQgridLogger({ serverUrl: SERVER });
    const messages = [
      { role: "system", content: "you are helpful" },
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "answer" }, { type: "tool-call", toolName: "getX" }] },
      { role: "tool", content: [{ type: "tool-result", output: "x" }] },
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

    const finishCall = calls.find((c) => c.url.includes("/finishRun"));
    expect(JSON.parse(String(finishCall?.body.input.history))).toEqual([
      { type: "message", role: "user", content: "hi" },
      { type: "message", role: "assistant", content: "answer" },
      { type: "message", role: "user", content: "follow-up" },
    ]);
  });

  it("keeps unmatched pending tool calls until a later step or finish", async () => {
    const calls = mockFetch();
    const logger = createQgridLogger({ serverUrl: SERVER });

    await logger.onStart!({
      model: { provider: "google", modelId: "gemini-3-flash" },
      prompt: "Weather in Seoul",
    } as never);

    await logger.onStepFinish!({
      stepNumber: 0,
      finishReason: "tool-calls",
      usage: { inputTokens: 200, outputTokens: 30, inputTokenDetails: {} },
      content: [
        { type: "tool-call", toolCallId: "call_1", toolName: "getWeather", input: { city: "Seoul" } },
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

    const toolCallStep = calls.find((c) => c.url.includes("/appendStep") && c.body.input.type === "tool_call");
    expect(toolCallStep?.body.input).toMatchObject({
      stepIndex: 0,
      toolName: "getWeather",
      toolArgs: '{"city":"Seoul"}',
    });
  });

  it("separates overlapping runs by metadata qgridRunId", async () => {
    const calls = mockFetch();
    const logger = createQgridLogger({ serverUrl: SERVER });

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
    expect(finishCalls.map((c) => c.body.input.response)).toEqual(["first response", "second response"]);
  });

  it("uses custom tokenName from config", async () => {
    const calls = mockFetch();
    const logger = createQgridLogger({ serverUrl: SERVER, tokenName: "...abc1" });

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
