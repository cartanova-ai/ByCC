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
});
