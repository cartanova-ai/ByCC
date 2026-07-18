import { beforeEach, describe, expect, it, vi } from "vitest";

import { afterQuery } from "./qgrid-run-lifecycle";
import { type QueryOutput } from "./qgrid.types";

const { appendStepMock, aggregateStepUsageMock, finishRunMock } = vi.hoisted(() => ({
  appendStepMock: vi.fn(),
  aggregateStepUsageMock: vi.fn(),
  finishRunMock: vi.fn(),
}));

vi.mock("../request-log/request-log.model", () => ({
  RequestLogModel: {
    appendStep: appendStepMock,
    aggregateStepUsage: aggregateStepUsageMock,
    finishRun: finishRunMock,
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

  it("preserves serving model, fallback count, TTL split, and exact step cost", async () => {
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
        requested_model_name: "claude-fable-5",
        model_name: "claude-opus-4-8",
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
        requested_model_name: "claude-fable-5",
        model_name: "claude-opus-4-8",
        fallback_count: 1,
        cache_creation_5m_tokens: 30_000,
        cache_creation_1h_tokens: 50_000,
        cost_usd: 3_000,
        cost_source: "provider",
      }),
    );
  });
});
