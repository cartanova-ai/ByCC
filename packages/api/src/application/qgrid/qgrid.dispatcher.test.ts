import { describe, expect, it, vi } from "vitest";

import {
  type GenerateRequest,
  type GenerateResult,
  type GenerateStreamCallbacks,
} from "../../utils/providers/common/provider-dispatcher";
import { buildStrictOutputSchema, QgridDispatcherClass } from "./qgrid.dispatcher";

function providerResult(overrides: Partial<GenerateResult> = {}): GenerateResult {
  return {
    text: "ok",
    tokenName: "provider/test",
    usage: {
      totalTokens: 10,
      inputTokens: 5,
      cachedInputTokens: 0,
      outputTokens: 5,
      reasoningOutputTokens: 0,
    },
    durationMs: 12,
    model: "model",
    threadCoord: { workerId: 1, threadId: "sess-1", epoch: 0 },
    ...overrides,
  };
}

describe("QgridDispatcherClass", () => {
  it("AnthropicDispatcher 미초기화 시 query 는 폴백 없이 실패한다", async () => {
    const dispatcher = new QgridDispatcherClass();

    await expect(
      dispatcher.query({ prompt: "hi", model: "anthropic/claude-sonnet-4-6" }),
    ).rejects.toThrow(/Anthropic dispatcher not initialized/);
  });

  it("AnthropicDispatcher 미초기화 시 queryStream 은 delta 없는 query 폴백 없이 실패한다", async () => {
    const dispatcher = new QgridDispatcherClass();

    await expect(
      dispatcher.queryStream(
        { prompt: "hi", model: "anthropic/claude-sonnet-4-6" },
        {
          onDelta: vi.fn(),
          onComplete: vi.fn(),
          onError: vi.fn(),
        },
      ),
    ).rejects.toThrow(/Anthropic dispatcher not initialized/);
  });

  it("provider prefix 없는 모델은 AnthropicDispatcher 로 암묵 라우팅하지 않는다", async () => {
    const dispatcher = new QgridDispatcherClass();
    const generate = vi.fn();
    dispatcher.anthropicDispatcher = { generate } as never;

    await expect(dispatcher.query({ prompt: "hi", model: "claude-sonnet-4-6" })).rejects.toThrow(
      /Direct LLM API fallback not implemented/,
    );
    expect(generate).not.toHaveBeenCalled();
  });

  it("Anthropic queryStream 은 abortSignal 을 provider request 로 전달한다", async () => {
    const dispatcher = new QgridDispatcherClass();
    const generateStream = vi.fn(async (_req: GenerateRequest, _cb: GenerateStreamCallbacks) => {});
    dispatcher.anthropicDispatcher = { generateStream } as never;
    const abortSignal = new AbortController().signal;

    await dispatcher.queryStream(
      { prompt: "hi", model: "anthropic/claude-sonnet-4-6" },
      {
        onDelta: vi.fn(),
        onComplete: vi.fn(),
        onError: vi.fn(),
      },
      abortSignal,
    );

    expect(generateStream.mock.calls[0]![0].abortSignal).toBe(abortSignal);
  });

  it("Anthropic queryStream provider error 는 상위 onError 로 전달한다", async () => {
    const dispatcher = new QgridDispatcherClass();
    const serverError = new Error(
      "claude error (anthropic/yds): API Error: 529 Overloaded. This is a server-side issue",
    );
    const generateStream = vi.fn(async (_req, cb) => {
      cb.onError(serverError);
    });
    dispatcher.anthropicDispatcher = { generateStream } as never;

    const onDelta = vi.fn();
    const onComplete = vi.fn();
    const onError = vi.fn();
    await dispatcher.queryStream(
      { prompt: "hi", model: "anthropic/claude-sonnet-4-6" },
      { onDelta, onComplete, onError },
    );

    expect(onDelta).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(serverError);
  });

  it("OpenAI query 는 reuse/reuseInput 을 provider 로 계속 전달한다", async () => {
    const dispatcher = new QgridDispatcherClass();
    const generate = vi.fn(async (_req: GenerateRequest) => providerResult({ model: "gpt-5.5" }));
    dispatcher.openaiDispatcher = { generate } as never;

    await dispatcher.query({
      prompt: "next",
      model: "openai/gpt-5.5",
      system: "same-system",
      runContext: {
        threadCoord: {
          workerId: 1,
          threadId: "thread-1",
          epoch: 0,
          systemHash: "800ddd9ba811b821",
        },
      },
    });

    const req = generate.mock.calls[0]![0];
    expect(req.reuse).toEqual({ workerId: 1, threadId: "thread-1", epoch: 0 });
    expect(req.reuseInput).toEqual([{ type: "text", text: "next", text_elements: [] }]);
  });

  it("Anthropic query 는 reuse/reuseInput 을 provider 로 전달하지 않는다", async () => {
    const dispatcher = new QgridDispatcherClass();
    const generate = vi.fn(async (_req: GenerateRequest) =>
      providerResult({ model: "claude-sonnet-4-6" }),
    );
    dispatcher.anthropicDispatcher = { generate } as never;

    await dispatcher.query({
      prompt: "next",
      model: "anthropic/claude-sonnet-4-6",
      system: "same-system",
      runContext: {
        threadCoord: {
          workerId: 1,
          threadId: "thread-1",
          epoch: 0,
          systemHash: "800ddd9ba811b821",
        },
      },
    });

    const req = generate.mock.calls[0]![0];
    expect(req).not.toHaveProperty("reuse");
    expect(req).not.toHaveProperty("reuseInput");
    expect(req.coldInput).toEqual([{ type: "text", text: "next", text_elements: [] }]);
  });

  it("Anthropic query 에도 imageGeneration 플래그를 전달해 provider 가 명시적으로 거부하게 한다", async () => {
    const dispatcher = new QgridDispatcherClass();
    const generate = vi.fn(async (_req: GenerateRequest) =>
      providerResult({ model: "claude-sonnet-4-6" }),
    );
    dispatcher.anthropicDispatcher = { generate } as never;

    await dispatcher.query({
      prompt: "draw",
      model: "anthropic/claude-sonnet-4-6",
      imageGeneration: true,
    });

    expect(generate.mock.calls[0]![0].imageGeneration).toBe(true);
  });

  it("Anthropic queryStream 도 reuse/reuseInput 을 provider 로 전달하지 않고 delta/complete 를 보존한다", async () => {
    const dispatcher = new QgridDispatcherClass();
    const generateStream = vi.fn(async (_req, cb) => {
      cb.onDelta("d");
      cb.onComplete(providerResult({ model: "claude-sonnet-4-6" }));
    });
    dispatcher.anthropicDispatcher = { generateStream } as never;

    const onDelta = vi.fn();
    const onComplete = vi.fn();
    await dispatcher.queryStream(
      {
        prompt: "next",
        model: "anthropic/claude-sonnet-4-6",
        system: "same-system",
        runContext: {
          threadCoord: {
            workerId: 1,
            threadId: "thread-1",
            epoch: 0,
            systemHash: "800ddd9ba811b821",
          },
        },
      },
      { onDelta, onComplete, onError: vi.fn() },
    );

    const req = generateStream.mock.calls[0]![0];
    expect(req).not.toHaveProperty("reuse");
    expect(req).not.toHaveProperty("reuseInput");
    expect(req.coldInput).toEqual([{ type: "text", text: "next", text_elements: [] }]);
    expect(onDelta).toHaveBeenCalledWith("d");
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "ok",
        runContext: expect.objectContaining({
          threadCoord: expect.objectContaining({ threadId: "sess-1" }),
        }),
      }),
    );
  });

  it("Anthropic queryStream 에도 imageGeneration 플래그를 전달해 provider 가 명시적으로 거부하게 한다", async () => {
    const dispatcher = new QgridDispatcherClass();
    const generateStream = vi.fn(async (_req, _cb) => {});
    dispatcher.anthropicDispatcher = { generateStream } as never;

    await dispatcher.queryStream(
      {
        prompt: "draw",
        model: "anthropic/claude-sonnet-4-6",
        imageGeneration: true,
      },
      { onDelta: vi.fn(), onComplete: vi.fn(), onError: vi.fn() },
    );

    expect(generateStream.mock.calls[0]![0].imageGeneration).toBe(true);
  });

  it("jsonSchema 를 required + additionalProperties:false 로 strictify 한다", () => {
    const schema = buildStrictOutputSchema({
      jsonSchema: JSON.stringify({
        type: "object",
        properties: {
          contents: {
            type: "array",
            items: {
              type: "object",
              properties: { text: { type: "string" } },
            },
          },
        },
      }),
    }) as {
      required?: string[];
      additionalProperties?: boolean;
      properties?: {
        contents?: {
          items?: { required?: string[]; additionalProperties?: boolean };
        };
      };
    };

    expect(schema.required).toEqual(["contents"]);
    expect(schema.additionalProperties).toBe(false);
    const contents = schema.properties?.contents as
      | { anyOf?: Array<{ items?: { required?: string[]; additionalProperties?: boolean } }> }
      | undefined;
    const contentsArray = contents?.anyOf?.[0];
    expect(contentsArray?.items?.required).toEqual(["text"]);
    expect(contentsArray?.items?.additionalProperties).toBe(false);
  });

  // SON-495: anthropic route 도 strict(required 유지)를 쓴다 — required 를 살려야 모델이 필드를
  // 빠짐없이 채운다(실측 확정). optionalize 는 제거됨.
  it("Anthropic route 에 strict(required 유지) outputSchema 를 전달한다", async () => {
    const dispatcher = new QgridDispatcherClass();
    const generate = vi.fn(
      async (_req: GenerateRequest): Promise<GenerateResult> => ({
        text: '{"contents":[{"text":"ok"}]}',
        tokenName: "anthropic/test",
        usage: {
          totalTokens: 10,
          inputTokens: 5,
          cachedInputTokens: 0,
          outputTokens: 5,
          reasoningOutputTokens: 0,
        },
        durationMs: 12,
        costUsd: 0.01,
        model: "claude-sonnet-4-6",
        threadCoord: { workerId: 1, threadId: "sess-1", epoch: 0 },
      }),
    );
    dispatcher.anthropicDispatcher = { generate } as never;

    await dispatcher.query({
      prompt: "hi",
      model: "anthropic/claude-sonnet-4-6",
      jsonSchema: JSON.stringify({
        type: "object",
        properties: { contents: { type: "array", items: { type: "object" } } },
      }),
    });

    const outputSchema = generate.mock.calls[0]![0].outputSchema as {
      required?: string[];
      additionalProperties?: boolean;
    };
    // anthropic 도 OpenAI 와 동일하게 strictify — required 살아있음
    expect(outputSchema.required).toEqual(["contents"]);
    expect(outputSchema.additionalProperties).toBe(false);
  });

  it("OpenAI route 도 strictify(required 유지)한다", async () => {
    const dispatcher = new QgridDispatcherClass();
    const generate = vi.fn(
      async (_req: GenerateRequest): Promise<GenerateResult> => ({
        text: '{"contents":[{"text":"ok"}]}',
        tokenName: "openai/test",
        usage: {
          totalTokens: 10,
          inputTokens: 5,
          cachedInputTokens: 0,
          outputTokens: 5,
          reasoningOutputTokens: 0,
        },
        durationMs: 12,
        costUsd: 0.01,
        model: "gpt-5.5",
        threadCoord: { workerId: 1, threadId: "sess-1", epoch: 0 },
      }),
    );
    dispatcher.openaiDispatcher = { generate } as never;

    await dispatcher.query({
      prompt: "hi",
      model: "openai/gpt-5.5",
      jsonSchema: JSON.stringify({
        type: "object",
        properties: { contents: { type: "array", items: { type: "object" } } },
      }),
    });

    const outputSchema = generate.mock.calls[0]![0].outputSchema as {
      required?: string[];
      additionalProperties?: boolean;
    };
    expect(outputSchema.required).toEqual(["contents"]);
    expect(outputSchema.additionalProperties).toBe(false);
  });

  it("provider 가 산출한 costUsd 를 가격표 fallback 보다 우선한다", async () => {
    const dispatcher = new QgridDispatcherClass();
    const generate = vi.fn(
      async (_req: GenerateRequest): Promise<GenerateResult> => ({
        text: "ok",
        tokenName: "anthropic/test",
        usage: {
          totalTokens: 1_110,
          inputTokens: 1_000,
          cachedInputTokens: 0,
          cacheCreationInputTokens: 600,
          outputTokens: 110,
          reasoningOutputTokens: 0,
        },
        durationMs: 12,
        costUsd: 0.123456,
        model: "claude-sonnet-4-6",
        threadCoord: { workerId: 1, threadId: "sess-1", epoch: 0 },
      }),
    );
    dispatcher.anthropicDispatcher = { generate } as never;

    const result = await dispatcher.query({ prompt: "hi", model: "anthropic/claude-sonnet-4-6" });

    expect(result.costUsd).toBe(0.123456);
    expect(result.usage.cache_creation_input_tokens).toBe(600);
  });

  it("provider cost 가 0이면 Anthropic 5m/1h cache breakdown 으로 fallback cost 를 계산한다", async () => {
    const dispatcher = new QgridDispatcherClass();
    const generate = vi.fn(
      async (_req: GenerateRequest): Promise<GenerateResult> => ({
        text: "ok",
        tokenName: "anthropic/test",
        usage: {
          totalTokens: 100_000,
          inputTokens: 100_000,
          cachedInputTokens: 0,
          cacheCreationInputTokens: 80_000,
          cacheCreationInputTokens5m: 30_000,
          cacheCreationInputTokens1h: 50_000,
          outputTokens: 0,
          reasoningOutputTokens: 0,
        },
        durationMs: 12,
        costUsd: 0,
        model: "claude-sonnet-4-6",
        threadCoord: { workerId: 1, threadId: "sess-1", epoch: 0 },
      }),
    );
    dispatcher.anthropicDispatcher = { generate } as never;

    const result = await dispatcher.query({ prompt: "hi", model: "anthropic/claude-sonnet-4-6" });

    expect(result.costUsd).toBeCloseTo(0.4725, 10);
    expect(result.usage.cache_creation_input_tokens).toBe(80_000);
    expect(result.usage.cache_creation_5m_input_tokens).toBe(30_000);
    expect(result.usage.cache_creation_1h_input_tokens).toBe(50_000);
    expect(result.costSource).toBe("pricing_table");
  });

  it("Fable refusal fallback은 실제 serving model과 requested model을 구분한다", async () => {
    const dispatcher = new QgridDispatcherClass();
    const generate = vi.fn(
      async (_req: GenerateRequest): Promise<GenerateResult> => ({
        text: "served by opus",
        tokenName: "anthropic/test",
        usage: {
          totalTokens: 120,
          inputTokens: 100,
          cachedInputTokens: 0,
          outputTokens: 20,
          reasoningOutputTokens: 0,
        },
        durationMs: 12,
        costUsd: 0.003,
        requestedModel: "claude-fable-5",
        model: "claude-opus-4-8",
        modelFallbacks: [
          {
            trigger: "refusal",
            fromModel: "claude-fable-5",
            toModel: "claude-opus-4-8",
            category: "cyber",
          },
        ],
        threadCoord: { workerId: 1, threadId: "sess-1", epoch: 0 },
      }),
    );
    dispatcher.anthropicDispatcher = { generate } as never;

    const result = await dispatcher.query({ prompt: "hi", model: "anthropic/claude-fable-5" });

    expect(result).toMatchObject({
      model: "claude-opus-4-8",
      requestedModel: "claude-fable-5",
      costUsd: 0.003,
      costSource: "provider",
      modelFallbacks: [
        {
          trigger: "refusal",
          fromModel: "claude-fable-5",
          toModel: "claude-opus-4-8",
          category: "cyber",
        },
      ],
    });
  });

  it("provider ttftMs 를 QueryOutput.ttftMs 로 매핑하고 누락 값은 0 으로 둔다", async () => {
    const dispatcher = new QgridDispatcherClass();
    const generate = vi
      .fn()
      .mockResolvedValueOnce(providerResult({ ttftMs: 37 }))
      .mockResolvedValueOnce(providerResult());
    dispatcher.openaiDispatcher = { generate } as never;

    await expect(
      dispatcher.query({ prompt: "hi", model: "openai/gpt-5.5" }),
    ).resolves.toMatchObject({ ttftMs: 37 });
    await expect(
      dispatcher.query({ prompt: "hi", model: "openai/gpt-5.5" }),
    ).resolves.toMatchObject({ ttftMs: 0 });
  });
});
