import { EventEmitter } from "node:events";

import { Sonamu } from "sonamu";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { QgridFrame } from "./qgrid.frame";
import { QueryInput } from "./qgrid.types";

const {
  findOneMock,
  findManyMock,
  saveMock,
  updateFieldsMock,
  requestLogSaveMock,
  requestLogCreateRunMock,
  appendStepMock,
  dispatcherQueryMock,
  dispatcherQueryStreamMock,
  beforeQueryMock,
  afterQueryMock,
  finishRunWithErrorMock,
  finishRunAbortedMock,
  getRateLimitsByTokenIdMock,
} = vi.hoisted(() => ({
  findOneMock: vi.fn(),
  findManyMock: vi.fn(),
  saveMock: vi.fn(),
  updateFieldsMock: vi.fn(),
  requestLogSaveMock: vi.fn(),
  requestLogCreateRunMock: vi.fn(),
  appendStepMock: vi.fn(),
  dispatcherQueryMock: vi.fn(),
  dispatcherQueryStreamMock: vi.fn(),
  beforeQueryMock: vi.fn(),
  afterQueryMock: vi.fn(),
  finishRunWithErrorMock: vi.fn(),
  finishRunAbortedMock: vi.fn(),
  getRateLimitsByTokenIdMock: vi.fn(),
}));

vi.mock("../request-log/request-log.model", () => ({
  MICRO_USD: 1_000_000,
  RequestLogModel: {
    save: requestLogSaveMock,
    createRun: requestLogCreateRunMock,
    appendStep: appendStepMock,
  },
}));

vi.mock("../token/token.model", () => ({
  TokenModel: {
    findOne: findOneMock,
    findMany: findManyMock,
    save: saveMock,
    updateFields: updateFieldsMock,
  },
}));

vi.mock("./qgrid.dispatcher", () => ({
  QgridDispatcher: {
    query: dispatcherQueryMock,
    queryStream: dispatcherQueryStreamMock,
    openaiDispatcher: {
      getRateLimitsByTokenId: getRateLimitsByTokenIdMock,
    },
  },
}));

vi.mock("./qgrid-run-lifecycle", () => ({
  beforeQuery: beforeQueryMock,
  afterQuery: afterQueryMock,
  finishRunWithError: finishRunWithErrorMock,
  finishRunAborted: finishRunAbortedMock,
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
  weight: 1,
};

describe("QgridFrame.updateToken", () => {
  beforeEach(() => {
    findOneMock.mockReset();
    saveMock.mockReset();
    saveMock.mockResolvedValue([1]);
    updateFieldsMock.mockReset().mockResolvedValue(1);
    requestLogSaveMock.mockReset();
    requestLogSaveMock.mockResolvedValue([1]);
    appendStepMock.mockReset();
    appendStepMock.mockResolvedValue(1);
    dispatcherQueryMock.mockReset();
  });

  it("rejects quota thresholds outside bounds before updating", async () => {
    await expect(QgridFrame.updateToken(1, "tok-A", 0)).rejects.toThrow(
      "quotaThreshold must be an integer between 1 and 100, or null",
    );

    expect(updateFieldsMock).not.toHaveBeenCalled();
  });

  it("updates only the supplied quota threshold", async () => {
    await expect(QgridFrame.updateToken(1, "tok-A", 80)).resolves.toEqual({ updated: true });

    expect(updateFieldsMock).toHaveBeenCalledWith(1, {
      name: "tok-A",
      quota_threshold: 80,
    });
  });

  it("rejects invalid weights before updating", async () => {
    await expect(QgridFrame.updateToken(1, "tok-A", undefined, 0)).rejects.toThrow(
      "weight must be an integer between 1 and 100",
    );

    expect(updateFieldsMock).not.toHaveBeenCalled();
  });

  it("updates only the supplied weight", async () => {
    await expect(QgridFrame.updateToken(1, undefined, undefined, 4)).resolves.toEqual({
      updated: true,
    });

    expect(updateFieldsMock).toHaveBeenCalledWith(1, { weight: 4 });
  });

  it("reports a missing token from the atomic update result", async () => {
    updateFieldsMock.mockResolvedValueOnce(0);

    await expect(QgridFrame.updateToken(404, undefined, undefined, 4)).resolves.toEqual({
      updated: false,
    });
  });
});

describe("QgridFrame.query request logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    beforeQueryMock.mockReset().mockResolvedValue({ requestLogId: 41, stepIndex: 0 });
    afterQueryMock.mockReset().mockResolvedValue({});
    finishRunWithErrorMock.mockReset();
    dispatcherQueryMock.mockReset();
  });

  function queryOutput() {
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
      ttftMs: 39,
      costUsd: 0.001,
      costSource: "pricing_table",
      runContext: {
        threadCoord: {
          workerId: 1,
          threadId: "thread-1",
          epoch: 2,
          systemHash: "system-hash",
        },
      },
    };
  }

  it("creates a run before dispatch when logger is omitted", async () => {
    const order: string[] = [];
    beforeQueryMock.mockImplementationOnce(async () => {
      order.push("before");
      return { requestLogId: 41, stepIndex: 0 };
    });
    dispatcherQueryMock.mockImplementationOnce(async () => {
      order.push("dispatch");
      return queryOutput();
    });
    afterQueryMock.mockImplementationOnce(async () => {
      order.push("after");
      return {};
    });

    const args = { prompt: "hi", model: "openai/gpt-5-codex" };
    const result = await QgridFrame.query(args);

    expect(order).toEqual(["before", "dispatch", "after"]);
    expect(beforeQueryMock).toHaveBeenCalledWith(args);
    expect(afterQueryMock).toHaveBeenCalledWith(41, 0, args, expect.objectContaining({ text: "hello" }));
    expect(result.runContext).toEqual(queryOutput().runContext);
  });

  it("does not create or update logs when logger is false", async () => {
    const output = queryOutput();
    dispatcherQueryMock.mockResolvedValueOnce(output);

    await expect(
      QgridFrame.query({ prompt: "hi", model: "openai/gpt-5-codex", logger: false }),
    ).resolves.toEqual(output);

    expect(beforeQueryMock).not.toHaveBeenCalled();
    expect(afterQueryMock).not.toHaveBeenCalled();
    expect(finishRunWithErrorMock).not.toHaveBeenCalled();
  });

  it("merges a tool run id with the provider thread coordinate", async () => {
    dispatcherQueryMock.mockResolvedValueOnce(queryOutput());
    afterQueryMock.mockResolvedValueOnce({ runContext: { requestLogId: 41 } });

    const result = await QgridFrame.query({ prompt: "hi", model: "openai/gpt-5-codex" });

    expect(result.runContext).toEqual({
      requestLogId: 41,
      threadCoord: queryOutput().runContext.threadCoord,
    });
  });

  it("finishes the pre-created run when provider execution fails", async () => {
    dispatcherQueryMock.mockRejectedValueOnce(new Error("provider failed"));
    const args = { prompt: "hi", model: "openai/gpt-5-codex" };

    await expect(QgridFrame.query(args)).rejects.toThrow("provider failed");

    expect(finishRunWithErrorMock).toHaveBeenCalledWith(41, "provider failed", args);
  });

  it("aborts provider execution and marks the run aborted when the HTTP response closes early", async () => {
    const requestRaw = Object.assign(new EventEmitter(), { aborted: false });
    const responseRaw = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
    });
    vi.spyOn(Sonamu, "getContext").mockReturnValue({
      transport: "http",
      request: { raw: requestRaw },
      reply: { raw: responseRaw },
    } as never);
    let providerSignal: AbortSignal | undefined;
    dispatcherQueryMock.mockImplementationOnce(
      (_args: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          providerSignal = signal;
          signal.addEventListener("abort", () => reject(new Error("provider aborted")), {
            once: true,
          });
        }),
    );
    const args = { prompt: "hi", model: "anthropic/claude-opus-5" };

    const queryPromise = QgridFrame.query(args);
    await vi.waitFor(() => expect(providerSignal).toBeDefined());
    responseRaw.destroyed = true;
    responseRaw.emit("close");

    await expect(queryPromise).rejects.toThrow("provider aborted");
    expect(providerSignal?.aborted).toBe(true);
    expect(finishRunAbortedMock).toHaveBeenCalledWith(41, args);
    expect(finishRunWithErrorMock).not.toHaveBeenCalled();
    expect(requestRaw.listenerCount("aborted")).toBe(0);
    expect(responseRaw.listenerCount("close")).toBe(0);
  });

  it("returns the provider result when afterQuery persistence fails", async () => {
    const output = queryOutput();
    dispatcherQueryMock.mockResolvedValueOnce(output);
    afterQueryMock.mockRejectedValueOnce(new Error("request log unavailable"));
    const args = { prompt: "hi", model: "openai/gpt-5-codex" };

    await expect(QgridFrame.query(args)).resolves.toBe(output);

    expect(finishRunWithErrorMock).toHaveBeenCalledWith(41, "request log unavailable", args);
  });

  it("rejects legacy logMode instead of silently enabling logging", async () => {
    const legacyInput = {
      prompt: "hi",
      model: "openai/gpt-5-codex",
      logMode: "none",
    } as unknown as Parameters<typeof QgridFrame.query>[0];

    await expect(QgridFrame.query(legacyInput)).rejects.toThrow(/logMode is no longer supported/);

    expect(beforeQueryMock).not.toHaveBeenCalled();
    expect(dispatcherQueryMock).not.toHaveBeenCalled();
  });

  it("rejects legacy logMode in the wire schema", () => {
    expect(QueryInput.safeParse({ prompt: "hi", logMode: "none" }).success).toBe(false);
    expect(QueryInput.safeParse({ prompt: "hi", logMode: undefined }).success).toBe(false);
    expect(QueryInput.safeParse({ prompt: "hi", logger: false }).success).toBe(true);
  });

  it("accepts bounded positive integer timeout values only", () => {
    expect(QueryInput.safeParse({ prompt: "hi", timeout: 360_000 }).success).toBe(true);
    expect(QueryInput.safeParse({ prompt: "hi", timeout: 0 }).success).toBe(false);
    expect(QueryInput.safeParse({ prompt: "hi", timeout: 1.5 }).success).toBe(false);
    expect(QueryInput.safeParse({ prompt: "hi", timeout: 1_800_001 }).success).toBe(false);
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

describe("QgridFrame raw lifecycle API", () => {
  it("treats createRun.modelName as the requested model", async () => {
    requestLogCreateRunMock.mockReset().mockResolvedValue(81);

    await expect(
      QgridFrame.createRun({
        userPrompt: "hi",
        modelName: "google/gemini-3-flash",
        projectName: "external",
      }),
    ).resolves.toEqual({ requestLogId: 81 });

    expect(requestLogCreateRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requested_model_name: "google/gemini-3-flash",
      }),
    );
    expect(requestLogCreateRunMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ model_name: expect.anything() }),
    );
  });
});

describe("QgridFrame.queryStream request logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    beforeQueryMock.mockReset().mockResolvedValue({ requestLogId: 52, stepIndex: 0 });
    afterQueryMock.mockReset().mockResolvedValue({});
    finishRunWithErrorMock.mockReset();
    finishRunAbortedMock.mockReset();
    dispatcherQueryStreamMock.mockReset();
  });

  function streamOutput() {
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
      ttftMs: 39,
      costUsd: 0.001,
      costSource: "pricing_table",
      runContext: {
        threadCoord: {
          workerId: 1,
          threadId: "thread-1",
          epoch: 2,
          systemHash: "system-hash",
        },
      },
    };
  }

  function installSseContext() {
    let closeHandler: (() => void) | undefined;
    const sse = {
      closed: false,
      publish: vi.fn(),
      onClose: vi.fn((handler: () => void) => {
        closeHandler = handler;
      }),
      end: vi.fn(async () => {}),
      triggerClose: () => closeHandler?.(),
    };
    vi.spyOn(Sonamu, "getContext").mockReturnValue({
      createSSE: vi.fn(() => sse),
    } as never);
    return sse;
  }

  it("creates the running row before starting provider streaming", async () => {
    const order: string[] = [];
    const sse = installSseContext();
    beforeQueryMock.mockImplementationOnce(async () => {
      order.push("before");
      return { requestLogId: 52, stepIndex: 0 };
    });
    dispatcherQueryStreamMock.mockImplementationOnce(
      async (
        _args: unknown,
        callbacks: { onComplete: (result: ReturnType<typeof streamOutput>) => void },
      ) => {
      order.push("dispatch");
      callbacks.onComplete(streamOutput());
      },
    );
    afterQueryMock.mockImplementationOnce(async () => {
      order.push("after");
      return {};
    });
    const args = { prompt: "hi", model: "openai/gpt-5-codex" };
    const { streamId } = await QgridFrame.prepareStream(args);

    await QgridFrame.queryStream(streamId);

    expect(order).toEqual(["before", "dispatch", "after"]);
    expect(sse.publish).toHaveBeenCalledWith(
      "done",
      expect.objectContaining({ runContext: streamOutput().runContext }),
    );
  });

  it("captures client close while beforeQuery is pending and skips provider dispatch", async () => {
    const sse = installSseContext();
    let beforeQueryStarted!: () => void;
    let resolveBeforeQuery!: (value: { requestLogId: number; stepIndex: number }) => void;
    const started = new Promise<void>((resolve) => {
      beforeQueryStarted = resolve;
    });
    beforeQueryMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveBeforeQuery = resolve;
          beforeQueryStarted();
        }),
    );
    const args = { prompt: "hi", model: "openai/gpt-5-codex" };
    const { streamId } = await QgridFrame.prepareStream(args);

    const streamPromise = QgridFrame.queryStream(streamId);
    await started;
    expect(sse.onClose).toHaveBeenCalledOnce();
    sse.triggerClose();
    resolveBeforeQuery({ requestLogId: 52, stepIndex: 0 });
    await streamPromise;

    expect(finishRunAbortedMock).toHaveBeenCalledWith(52, args);
    expect(dispatcherQueryStreamMock).not.toHaveBeenCalled();
    expect(sse.end).toHaveBeenCalledOnce();
  });

  it("publishes the provider result when afterQuery persistence fails", async () => {
    const sse = installSseContext();
    dispatcherQueryStreamMock.mockImplementationOnce(
      async (
        _args: unknown,
        callbacks: { onComplete: (result: ReturnType<typeof streamOutput>) => void },
      ) => {
        callbacks.onComplete(streamOutput());
      },
    );
    afterQueryMock.mockRejectedValueOnce(new Error("request log unavailable"));
    const args = { prompt: "hi", model: "openai/gpt-5-codex" };
    const { streamId } = await QgridFrame.prepareStream(args);

    await QgridFrame.queryStream(streamId);

    expect(finishRunWithErrorMock).toHaveBeenCalledWith(52, "request log unavailable", args);
    expect(sse.publish).toHaveBeenCalledWith(
      "done",
      expect.objectContaining({ text: "hello", runContext: streamOutput().runContext }),
    );
    expect(sse.publish).not.toHaveBeenCalledWith("error", expect.anything());
  });

  it("publishes an error when provider execution fails while the client is connected", async () => {
    const sse = installSseContext();
    dispatcherQueryStreamMock.mockImplementationOnce(
      async (_args: unknown, callbacks: { onError: (error: Error) => void }) => {
        callbacks.onError(new Error("provider failed"));
      },
    );
    const args = { prompt: "hi", model: "openai/gpt-5-codex" };
    const { streamId } = await QgridFrame.prepareStream(args);

    await QgridFrame.queryStream(streamId);

    expect(finishRunWithErrorMock).toHaveBeenCalledWith(52, "provider failed", args);
    expect(finishRunAbortedMock).not.toHaveBeenCalled();
    expect(sse.publish).toHaveBeenCalledWith("error", { message: "provider failed" });
  });

  it("marks the run aborted on close regardless of the provider error message", async () => {
    const sse = installSseContext();
    dispatcherQueryStreamMock.mockImplementationOnce(
      async (
        _args: unknown,
        callbacks: { onError: (error: Error) => void },
        signal: AbortSignal,
      ) => {
        expect(signal.aborted).toBe(false);
        sse.triggerClose();
        expect(signal.aborted).toBe(true);
        callbacks.onError(new Error("provider connection reset"));
      },
    );
    const args = { prompt: "hi", model: "openai/gpt-5-codex" };
    const { streamId } = await QgridFrame.prepareStream(args);

    await QgridFrame.queryStream(streamId);

    expect(finishRunAbortedMock).toHaveBeenCalledWith(52, args);
    expect(finishRunWithErrorMock).not.toHaveBeenCalled();
    expect(sse.publish).not.toHaveBeenCalled();
  });

  it("records a provider result after close but finishes the run as aborted", async () => {
    const sse = installSseContext();
    dispatcherQueryStreamMock.mockImplementationOnce(
      async (
        _args: unknown,
        callbacks: { onComplete: (result: ReturnType<typeof streamOutput>) => void },
      ) => {
        sse.triggerClose();
        callbacks.onComplete(streamOutput());
      },
    );
    const args = { prompt: "hi", model: "openai/gpt-5-codex" };
    const { streamId } = await QgridFrame.prepareStream(args);

    await QgridFrame.queryStream(streamId);

    expect(afterQueryMock).toHaveBeenCalledWith(52, 0, args, streamOutput());
    expect(finishRunAbortedMock).toHaveBeenCalledWith(52, args);
    expect(sse.publish).not.toHaveBeenCalled();
  });

  it("marks the run aborted when the client closes before afterQuery commits", async () => {
    const sse = installSseContext();
    let afterQueryStarted!: () => void;
    let resolveAfterQuery!: (value: object) => void;
    const started = new Promise<void>((resolve) => {
      afterQueryStarted = resolve;
    });
    afterQueryMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveAfterQuery = resolve;
          afterQueryStarted();
        }),
    );
    dispatcherQueryStreamMock.mockImplementationOnce(
      async (
        _args: unknown,
        callbacks: { onComplete: (result: ReturnType<typeof streamOutput>) => void },
      ) => {
        callbacks.onComplete(streamOutput());
      },
    );
    const args = { prompt: "hi", model: "openai/gpt-5-codex" };
    const { streamId } = await QgridFrame.prepareStream(args);

    const streamPromise = QgridFrame.queryStream(streamId);
    await started;
    sse.triggerClose();
    resolveAfterQuery({});
    await streamPromise;

    expect(finishRunAbortedMock).toHaveBeenCalledWith(52, args);
    expect(sse.publish).not.toHaveBeenCalledWith("done", expect.anything());
  });

  it("streams with thread context but no log writes when logger is false", async () => {
    const sse = installSseContext();
    dispatcherQueryStreamMock.mockImplementationOnce(
      async (
        _args: unknown,
        callbacks: { onComplete: (result: ReturnType<typeof streamOutput>) => void },
      ) => {
        callbacks.onComplete(streamOutput());
      },
    );
    const { streamId } = await QgridFrame.prepareStream({
      prompt: "hi",
      model: "openai/gpt-5-codex",
      logger: false,
    });

    await QgridFrame.queryStream(streamId);

    expect(beforeQueryMock).not.toHaveBeenCalled();
    expect(afterQueryMock).not.toHaveBeenCalled();
    expect(finishRunWithErrorMock).not.toHaveBeenCalled();
    expect(sse.onClose).toHaveBeenCalledOnce();
    expect(sse.publish).toHaveBeenCalledWith(
      "done",
      expect.objectContaining({ runContext: streamOutput().runContext }),
    );
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

  it("returns the provider-reported OpenAI window duration", async () => {
    findManyMock.mockResolvedValueOnce({
      rows: [{ ...tokenEntry, provider: "openai", active: true }],
    });
    getRateLimitsByTokenIdMock.mockResolvedValueOnce({
      data: {
        rateLimits: {
          primary: { usedPercent: 11, resetsAt: 1_784_000_000, windowDurationMins: 10_080 },
          secondary: null,
        },
      },
    });

    await expect(QgridFrame.usage(1)).resolves.toEqual({
      provider: "openai",
      fiveHour: {
        utilization: 11,
        resetsAt: new Date(1_784_000_000 * 1_000).toISOString(),
        windowDurationMins: 10_080,
      },
      sevenDay: null,
    });
  });
});
