import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  afterQuery,
  beforeQuery,
  finishRunAborted,
  finishRunWithError,
} from "./qgrid-run-lifecycle";
import { type QueryOutput } from "./qgrid.types";

const {
  appendStepMock,
  aggregateStepUsageMock,
  finishRunMock,
  createRunMock,
  expireStaleToolWaitingRunsMock,
  continueToolRunMock,
} = vi.hoisted(() => ({
  appendStepMock: vi.fn(),
  aggregateStepUsageMock: vi.fn(),
  finishRunMock: vi.fn(),
  createRunMock: vi.fn(),
  expireStaleToolWaitingRunsMock: vi.fn(),
  continueToolRunMock: vi.fn(),
}));

vi.mock("../request-log/request-log.model", () => ({
  RequestLogModel: {
    appendStep: appendStepMock,
    aggregateStepUsage: aggregateStepUsageMock,
    finishRun: finishRunMock,
    createRun: createRunMock,
    expireStaleToolWaitingRuns: expireStaleToolWaitingRunsMock,
    continueToolRun: continueToolRunMock,
  },
}));

function queryOutput(overrides: Partial<QueryOutput> = {}): QueryOutput {
  return {
    text: "hello",
    content: [],
    finishReason: "stop",
    tokenName: "tok-A",
    model: "gpt-5-codex",
    usage: {
      input_tokens: 5,
      output_tokens: 7,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    durationMs: 120,
    ttftMs: 39,
    costUsd: 0.001,
    costSource: "pricing_table",
    ...overrides,
  };
}

let lifecycleNow = Date.now();

describe("qgrid run lifecycle start", () => {
  beforeEach(() => {
    lifecycleNow += 60_001;
    vi.spyOn(Date, "now").mockReturnValue(lifecycleNow);
    createRunMock.mockReset().mockResolvedValue(10);
    expireStaleToolWaitingRunsMock.mockReset().mockResolvedValue([]);
    continueToolRunMock.mockReset().mockResolvedValue(3);
    aggregateStepUsageMock.mockReset().mockResolvedValue({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      duration_ms: 0,
      fallback_count: 0,
      cost_usd: 0,
    });
    finishRunMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a running parent with the full requested model before an initial query", async () => {
    const history = JSON.stringify([
      { type: "message", role: "user", content: "earlier" },
      { type: "message", role: "system", content: "hidden" },
      { type: "tool-result", output: "ignored" },
    ]);

    await expect(
      beforeQuery({
        prompt: "hi",
        system: "system",
        model: "openai/gpt-5-codex",
        projectName: "project",
        history,
      }),
    ).resolves.toEqual({ requestLogId: 10, stepIndex: 0 });

    expect(createRunMock).toHaveBeenCalledWith({
      user_prompt: "hi",
      system_prompt: "system",
      requested_model_name: "openai/gpt-5-codex",
      effort: undefined,
      project_name: "project",
      history: [{ type: "message", role: "user", content: "earlier" }],
      is_image_generation: undefined,
    });
  });

  it("continues an existing parent and completes tool results before the next step", async () => {
    const order: string[] = [];
    continueToolRunMock.mockImplementationOnce(async () => {
      order.push("continue-tool-run");
      return 3;
    });
    expireStaleToolWaitingRunsMock.mockImplementationOnce(async () => {
      order.push("cleanup-stale");
      return [77];
    });
    const args = {
      prompt: "continue",
      runContext: { requestLogId: 10 },
      toolResults: [{ toolCallId: "call-1", output: "sunny" }],
    };

    await expect(beforeQuery(args)).resolves.toEqual({ requestLogId: 10, stepIndex: 3 });

    expect(createRunMock).not.toHaveBeenCalled();
    expect(continueToolRunMock).toHaveBeenCalledWith(10, [
      { toolCallId: "call-1", output: "sunny" },
    ]);
    expect(order).toEqual(["continue-tool-run", "cleanup-stale"]);
    expect(finishRunMock).not.toHaveBeenCalled();
  });

  it("cleans up only stale unresolved tool-wait runs reported by the model", async () => {
    expireStaleToolWaitingRunsMock.mockResolvedValueOnce([77]);

    await beforeQuery({ prompt: "hi", model: "openai/gpt-5-codex" });

    expect(expireStaleToolWaitingRunsMock).toHaveBeenCalledWith(
      30 * 60 * 1000,
      "tool-call run: no follow-up within 30 minutes",
    );
    expect(finishRunMock).not.toHaveBeenCalled();
  });

  it("throttles stale cleanup while still creating every requested run", async () => {
    await beforeQuery({ prompt: "one", model: "openai/gpt-5-codex" });
    await beforeQuery({ prompt: "two", model: "openai/gpt-5-codex" });

    expect(expireStaleToolWaitingRunsMock).toHaveBeenCalledTimes(1);
    expect(createRunMock).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight stale cleanup across concurrent requests", async () => {
    let resolveCleanup: ((ids: number[]) => void) | undefined;
    expireStaleToolWaitingRunsMock.mockReturnValueOnce(
      new Promise<number[]>((resolve) => {
        resolveCleanup = resolve;
      }),
    );

    const first = beforeQuery({ prompt: "one", model: "openai/gpt-5-codex" });
    await vi.waitFor(() => expect(expireStaleToolWaitingRunsMock).toHaveBeenCalledTimes(1));
    const second = beforeQuery({ prompt: "two", model: "openai/gpt-5-codex" });

    expect(expireStaleToolWaitingRunsMock).toHaveBeenCalledTimes(1);
    resolveCleanup?.([]);
    await Promise.all([first, second]);

    expect(expireStaleToolWaitingRunsMock).toHaveBeenCalledTimes(1);
    expect(createRunMock).toHaveBeenCalledTimes(2);
  });
});

describe("qgrid run lifecycle TTFT", () => {
  beforeEach(() => {
    appendStepMock.mockReset();
    aggregateStepUsageMock.mockReset();
    aggregateStepUsageMock.mockResolvedValue({
      input_tokens: 5,
      output_tokens: 7,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      duration_ms: 120,
    });
    finishRunMock.mockReset();
  });

  it("appends generate step ttft_ms from QueryOutput", async () => {
    await afterQuery(10, 2, { prompt: "hi" }, queryOutput({ ttftMs: 44 }));

    expect(appendStepMock).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        step_index: 2,
        type: "generate",
        duration_ms: 120,
        ttft_ms: 44,
      }),
    );
  });

  it("preserves generate step ttft_ms zero when no first-token timing is available", async () => {
    await afterQuery(
      10,
      2,
      { prompt: "hi" },
      queryOutput({ finishReason: "tool-calls", ttftMs: 0 }),
    );

    expect(appendStepMock).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        ttft_ms: 0,
      }),
    );
    expect(finishRunMock).not.toHaveBeenCalled();
  });

  it("does not pass ttft into finishRun params because the model derives the run value", async () => {
    await afterQuery(10, 2, { prompt: "hi" }, queryOutput({ ttftMs: 44 }));

    expect(finishRunMock).toHaveBeenCalledWith(
      10,
      expect.not.objectContaining({
        ttft_ms: expect.anything(),
        ttftMs: expect.anything(),
      }),
    );
  });

  it("persists an immediate structured final answer as JSON text", async () => {
    await afterQuery(
      10,
      0,
      {
        prompt: "answer",
        tools: [{ name: "lookup", inputSchema: { type: "object" } }],
        jsonSchema: JSON.stringify({
          type: "object",
          properties: { result: { type: "string" } },
        }),
      },
      queryOutput({
        text: '{"result":"ok"}',
        content: [{ type: "text", text: '{"result":"ok"}' }],
      }),
    );

    expect(appendStepMock).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        step_index: 0,
        type: "generate",
        finish_reason: "stop",
      }),
    );
    expect(finishRunMock).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        status: "succeeded",
        response: '{"result":"ok"}',
      }),
    );
  });

  it("persists a tool turn and a structured final answer on the continued run", async () => {
    const schema = JSON.stringify({
      type: "object",
      properties: { result: { type: "string" } },
    });
    const first = await afterQuery(
      10,
      0,
      { prompt: "lookup", tools: [{ name: "lookup", inputSchema: {} }], jsonSchema: schema },
      queryOutput({
        text: "",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "lookup",
            input: '{"key":"value"}',
          },
        ],
        finishReason: "tool-calls",
      }),
    );

    expect(first).toEqual({ runContext: { requestLogId: 10 } });
    expect(finishRunMock).not.toHaveBeenCalled();
    expect(appendStepMock).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        step_index: 0,
        type: "tool_call",
        tool_call_id: "call-1",
      }),
    );

    await afterQuery(
      10,
      2,
      {
        prompt: "continue",
        tools: [{ name: "lookup", inputSchema: {} }],
        jsonSchema: schema,
        runContext: { requestLogId: 10 },
        toolResults: [{ toolCallId: "call-1", output: '{"value":"found"}' }],
      },
      queryOutput({
        text: '{"result":"found"}',
        content: [{ type: "text", text: '{"result":"found"}' }],
        finishReason: "stop",
      }),
    );

    expect(appendStepMock).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        step_index: 2,
        type: "generate",
        finish_reason: "stop",
      }),
    );
    expect(finishRunMock).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        status: "succeeded",
        response: '{"result":"found"}',
      }),
    );
  });

  it("finishes runs with image data-url img tags in response", async () => {
    await afterQuery(
      10,
      2,
      { prompt: "draw", imageGeneration: true },
      queryOutput({
        text: "image ready",
        content: [
          { type: "text", text: "image ready" },
          { type: "image", data: "iVBORw0KGgoBAgM", revisedPrompt: "green triangle" },
        ],
      }),
    );

    expect(finishRunMock).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        response:
          'image ready\n<img src="data:image/png;base64,iVBORw0KGgoBAgM" alt="green triangle" />',
      }),
    );
  });

  it("records image generation as a completed synthetic tool call step", async () => {
    await afterQuery(
      10,
      2,
      { prompt: "draw a green triangle", model: "openai/gpt-5.5", imageGeneration: true },
      queryOutput({
        text: "image ready",
        content: [
          { type: "text", text: "image ready" },
          { type: "image", data: "iVBORw0KGgoBAgM", revisedPrompt: "green triangle" },
        ],
      }),
    );

    expect(appendStepMock).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        step_index: 2,
        type: "tool_call",
        tool_call_index: 0,
        tool_call_id: "image_generation:2:0",
        tool_name: "image_generation",
        tool_args: JSON.stringify({
          prompt: "draw a green triangle",
          driverModel: "openai/gpt-5.5",
          tool: {
            type: "image_generation",
            outputFormat: "png",
          },
          pricingAssumption: {
            model: "gpt-image-2",
            quality: "medium",
            size: "1536x1024",
          },
        }),
        tool_result: '<img src="data:image/png;base64,iVBORw0KGgoBAgM" alt="green triangle" />',
      }),
    );
  });

  it("passes configured image generation cost estimate into finishRun", async () => {
    await afterQuery(
      10,
      2,
      { prompt: "draw", imageGeneration: true },
      queryOutput({
        content: [{ type: "image", data: "iVBORw0KGgoBAgM", revisedPrompt: "green triangle" }],
      }),
    );

    expect(finishRunMock).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        image_cost_usd: 41000,
        image_cost_method: "assumed:gpt-image-2:medium:1536x1024:png",
      }),
    );
  });

  it("uses requested image quality and size for cost estimate", async () => {
    await afterQuery(
      10,
      2,
      {
        prompt: "draw",
        imageGeneration: true,
        imageGenerationOptions: { quality: "high", size: "1024x1024" },
      },
      queryOutput({
        content: [{ type: "image", data: "iVBORw0KGgoBAgM", revisedPrompt: "green triangle" }],
      }),
    );

    expect(finishRunMock).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        image_cost_usd: 211000,
        image_cost_method: "assumed:gpt-image-2:high:1024x1024:png",
      }),
    );
  });

  it("stores full routed models, fallback count, TTL split, and exact step cost", async () => {
    aggregateStepUsageMock.mockResolvedValueOnce({
      input_tokens: 100_000,
      output_tokens: 20,
      cache_read_tokens: 10_000,
      cache_creation_tokens: 80_000,
      cache_creation_5m_tokens: 30_000,
      cache_creation_1h_tokens: 50_000,
      duration_ms: 120,
      cost_usd: 3_000,
      cost_source: "provider",
      fallback_count: 1,
    });

    await afterQuery(
      10,
      2,
      { prompt: "hi", model: "anthropic/claude-fable-5" },
      queryOutput({
        model: "claude-opus-4-8",
        requestedModel: "claude-fable-5",
        modelFallbacks: [
          {
            trigger: "refusal",
            fromModel: "claude-fable-5",
            toModel: "claude-opus-4-8",
          },
        ],
        costUsd: 0.003,
        costSource: "provider",
        usage: {
          input_tokens: 100_000,
          output_tokens: 20,
          cache_read_input_tokens: 10_000,
          cache_creation_input_tokens: 80_000,
          cache_creation_5m_input_tokens: 30_000,
          cache_creation_1h_input_tokens: 50_000,
        },
      }),
    );

    expect(appendStepMock).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        requested_model_name: "anthropic/claude-fable-5",
        model_name: "anthropic/claude-opus-4-8",
        fallback_count: 1,
        cache_creation_5m_tokens: 30_000,
        cache_creation_1h_tokens: 50_000,
        cost_usd: 3_000,
        cost_source: "provider",
      }),
    );
    expect(finishRunMock).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        requested_model_name: "anthropic/claude-fable-5",
        model_name: "anthropic/claude-opus-4-8",
        fallback_count: 1,
        cache_creation_5m_tokens: 30_000,
        cache_creation_1h_tokens: 50_000,
        cost_usd: 3_000,
        cost_source: "provider",
      }),
    );
  });

  it("preserves the exact Anthropic 1M requested route after provider canonicalization", async () => {
    await afterQuery(
      10,
      2,
      { prompt: "hi", model: "anthropic/claude-sonnet-4-6[1m]" },
      queryOutput({
        model: "claude-sonnet-4-6",
        requestedModel: "claude-sonnet-4-6",
      }),
    );

    expect(appendStepMock).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        requested_model_name: "anthropic/claude-sonnet-4-6[1m]",
        model_name: "anthropic/claude-sonnet-4-6",
      }),
    );
    expect(finishRunMock).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        requested_model_name: "anthropic/claude-sonnet-4-6[1m]",
        model_name: "anthropic/claude-sonnet-4-6",
      }),
    );
  });
});

describe("qgrid run lifecycle terminal rollup", () => {
  beforeEach(() => {
    aggregateStepUsageMock.mockReset().mockResolvedValue({
      input_tokens: 120,
      output_tokens: 30,
      cache_read_tokens: 20,
      cache_creation_tokens: 40,
      cache_creation_5m_tokens: 15,
      cache_creation_1h_tokens: 25,
      duration_ms: 900,
      fallback_count: 1,
      cost_usd: 7_500,
      cost_source: "mixed",
    });
    finishRunMock.mockReset();
  });

  it("keeps incurred step usage and cost when a run ends in error", async () => {
    await finishRunWithError(10, "provider failed", {
      prompt: "continue",
      history: JSON.stringify([{ type: "message", role: "user", content: "prior" }]),
    });

    expect(finishRunMock).toHaveBeenCalledWith(10, {
      status: "error",
      error_message: "provider failed",
      history: [{ type: "message", role: "user", content: "prior" }],
      input_tokens: 120,
      output_tokens: 30,
      cache_read_tokens: 20,
      cache_creation_tokens: 40,
      cache_creation_5m_tokens: 15,
      cache_creation_1h_tokens: 25,
      duration_ms: 900,
      fallback_count: 1,
      cost_usd: 7_500,
      cost_source: "mixed",
    });
  });

  it("keeps incurred step usage and cost when a run is aborted", async () => {
    await finishRunAborted(10, { prompt: "continue" });

    expect(finishRunMock).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        status: "aborted",
        error_message: "client disconnected",
        input_tokens: 120,
        output_tokens: 30,
        cost_usd: 7_500,
        cost_source: "mixed",
      }),
    );
  });

  it("still writes the terminal status when usage aggregation fails", async () => {
    aggregateStepUsageMock.mockRejectedValueOnce(new Error("aggregate failed"));

    await finishRunWithError(10, "provider failed");

    expect(finishRunMock).toHaveBeenCalledWith(10, {
      status: "error",
      error_message: "provider failed",
      history: undefined,
    });
  });
});
