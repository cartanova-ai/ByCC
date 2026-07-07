import { beforeEach, describe, expect, it, vi } from "vitest";

import { QgridFrame } from "./qgrid.frame";

const {
  findOneMock,
  findManyMock,
  saveMock,
  requestLogSaveMock,
  appendStepMock,
  dispatcherQueryMock,
  getRateLimitsByTokenIdMock,
} = vi.hoisted(() => ({
  findOneMock: vi.fn(),
  findManyMock: vi.fn(),
  saveMock: vi.fn(),
  requestLogSaveMock: vi.fn(),
  appendStepMock: vi.fn(),
  dispatcherQueryMock: vi.fn(),
  getRateLimitsByTokenIdMock: vi.fn(),
}));

vi.mock("../request-log/request-log.model", () => ({
  MICRO_USD: 1_000_000,
  RequestLogModel: {
    save: requestLogSaveMock,
    appendStep: appendStepMock,
  },
}));

vi.mock("../token/token.model", () => ({
  TokenModel: {
    findOne: findOneMock,
    findMany: findManyMock,
    save: saveMock,
  },
}));

vi.mock("./qgrid.dispatcher", () => ({
  QgridDispatcher: {
    query: dispatcherQueryMock,
    openaiDispatcher: {
      getRateLimitsByTokenId: getRateLimitsByTokenIdMock,
    },
  },
}));

const tokenEntry = {
  id: 1,
  created_at: new Date("2026-06-30T00:00:00.000Z"),
  provider: "anthropic",
  credentials: {
    accessToken: "sk-ant-oat01-test",
    refreshToken: "sk-ant-ort01-test",
    expiresAt: Date.now() + 3_600_000,
    accountUuid: "acc-1",
  },
  name: "tok-A",
  active: true,
  ord: 0,
  quota_threshold: null,
};

describe("QgridFrame.updateToken", () => {
  beforeEach(() => {
    findOneMock.mockReset();
    saveMock.mockReset();
    saveMock.mockResolvedValue([1]);
    requestLogSaveMock.mockReset();
    requestLogSaveMock.mockResolvedValue([1]);
    appendStepMock.mockReset();
    appendStepMock.mockResolvedValue(1);
    dispatcherQueryMock.mockReset();
  });

  it("rejects quota thresholds outside TokenSaveParams bounds before saving", async () => {
    findOneMock.mockResolvedValueOnce(tokenEntry);

    await expect(QgridFrame.updateToken(1, "tok-A", 0)).rejects.toThrow(
      "quotaThreshold must be an integer between 1 and 100, or null",
    );

    expect(saveMock).not.toHaveBeenCalled();
  });

  it("saves valid quota thresholds through the same schema used by token saves", async () => {
    findOneMock.mockResolvedValueOnce(tokenEntry);

    await expect(QgridFrame.updateToken(1, "tok-A", 80)).resolves.toEqual({ updated: true });

    expect(saveMock).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 1,
        name: "tok-A",
        quota_threshold: 80,
      }),
    ]);
  });
});

describe("QgridFrame.query auto logging", () => {
  beforeEach(() => {
    requestLogSaveMock.mockReset();
    requestLogSaveMock.mockResolvedValue([1]);
    appendStepMock.mockReset();
    dispatcherQueryMock.mockReset();
  });

  function queryOutput(ttftMs: number) {
    return {
      text: "hello",
      content: [{ type: "text", text: "hello" }],
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
      ttftMs,
      costUsd: 0.001,
    };
  }

  it("persists auto request ttft_ms from QueryOutput", async () => {
    dispatcherQueryMock.mockResolvedValueOnce(queryOutput(39));

    await QgridFrame.query({ prompt: "hi", model: "openai/gpt-5-codex", logMode: "auto" });

    expect(requestLogSaveMock).toHaveBeenCalledWith([
      expect.objectContaining({ duration_ms: 120, ttft_ms: 39 }),
    ]);
  });

  it("persists auto request ttft_ms zero when no first-token timing is available", async () => {
    dispatcherQueryMock.mockResolvedValueOnce(queryOutput(0));

    await QgridFrame.query({ prompt: "hi", model: "openai/gpt-5-codex", logMode: "auto" });

    expect(requestLogSaveMock).toHaveBeenCalledWith([
      expect.objectContaining({ ttft_ms: 0 }),
    ]);
  });

  it("persists image parts in response as data-url img tags", async () => {
    dispatcherQueryMock.mockResolvedValueOnce({
      ...queryOutput(39),
      text: "image ready",
      content: [
        { type: "text", text: "image ready" },
        { type: "image", data: "iVBORw0KGgoBAgM", revisedPrompt: "green triangle" },
      ],
    });

    await QgridFrame.query({
      prompt: "draw",
      input: [
        { type: "text", text: "draw", text_elements: [] },
        { type: "image", url: "data:image/webp;base64,UklGRg==" },
      ],
      model: "openai/gpt-5-codex",
      logMode: "auto",
      imageGeneration: true,
    });

    expect(requestLogSaveMock).toHaveBeenCalledWith([
      expect.objectContaining({
        response:
          'image ready\n<img src="data:image/png;base64,iVBORw0KGgoBAgM" alt="green triangle" />',
        tool_call_count: 0,
        is_image_generation: true,
        image_cost_usd: 41000,
        image_cost_method: "assumed:gpt-image-2:medium:1536x1024:png",
      }),
    ]);
    expect(appendStepMock).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        step_index: 0,
        type: "tool_call",
        tool_call_index: 0,
        tool_call_id: "image_generation:0:0",
        tool_name: "image_generation",
        tool_args: JSON.stringify({
          prompt: "draw",
          inputImages: [{ mediaType: "image/webp", data: "UklGRg==", byteSize: 4 }],
          driverModel: "openai/gpt-5-codex",
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

  it("stores input images only on the first image-generation tool step", async () => {
    dispatcherQueryMock.mockResolvedValueOnce({
      ...queryOutput(39),
      text: "images ready",
      content: [
        { type: "image", data: "first", revisedPrompt: "first image" },
        { type: "image", data: "second", revisedPrompt: "second image" },
      ],
    });

    await QgridFrame.query({
      prompt: "draw two",
      input: [
        { type: "text", text: "draw two", text_elements: [] },
        { type: "image", url: "data:image/webp;base64,UklGRg==" },
      ],
      model: "openai/gpt-5-codex",
      logMode: "auto",
      imageGeneration: true,
    });

    const firstToolArgs = JSON.parse(appendStepMock.mock.calls[0]![1].tool_args);
    const secondToolArgs = JSON.parse(appendStepMock.mock.calls[1]![1].tool_args);

    expect(firstToolArgs.inputImages).toEqual([
      { mediaType: "image/webp", data: "UklGRg==", byteSize: 4 },
    ]);
    expect(secondToolArgs.inputImages).toBeUndefined();
  });
});

describe("QgridFrame.prepareStream", () => {
  beforeEach(() => {
    dispatcherQueryMock.mockReset();
    requestLogSaveMock.mockReset();
  });

  it("rejects imageGeneration before creating an SSE stream", async () => {
    await expect(
      QgridFrame.prepareStream({
        prompt: "draw",
        model: "openai/gpt-5-codex",
        imageGeneration: true,
      }),
    ).rejects.toThrow(/imageGeneration is not supported with streaming/);

    expect(dispatcherQueryMock).not.toHaveBeenCalled();
    expect(requestLogSaveMock).not.toHaveBeenCalled();
  });
});

describe("QgridFrame.usage", () => {
  beforeEach(() => {
    findManyMock.mockReset();
    getRateLimitsByTokenIdMock.mockReset();
  });

  it("returns empty usage for inactive OpenAI tokens without asking for workers", async () => {
    findManyMock.mockResolvedValueOnce({
      rows: [
        {
          ...tokenEntry,
          provider: "openai",
          credentials: {
            accessToken: "access",
            refreshToken: "refresh",
            accountId: "account",
          },
          active: false,
        },
      ],
    });

    await expect(QgridFrame.usage(1)).resolves.toEqual({
      provider: "openai",
      fiveHour: null,
      sevenDay: null,
    });
    expect(getRateLimitsByTokenIdMock).not.toHaveBeenCalled();
  });
});
