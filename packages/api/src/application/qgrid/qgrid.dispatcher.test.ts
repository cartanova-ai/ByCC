import { describe, expect, it, vi } from "vitest";

import {
  type GenerateRequest,
  type GenerateResult,
  type GenerateStreamCallbacks,
} from "../../utils/providers/common/provider-dispatcher";
import { systemHash } from "./conv-routing";
import { buildStrictOutputSchema, QgridDispatcherClass } from "./qgrid.dispatcher";
import { type QueryOutput } from "./qgrid.types";

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

function deeplyNestedOutputSchema(depth: number): string {
  const nestedArray = `${'{"type":"array","items":'.repeat(depth)}{"type":"string"}${"}".repeat(depth)}`;
  return `{"type":"object","properties":{"value":${nestedArray}}}`;
}

describe("QgridDispatcherClass", () => {
  const toolsAndSchema = {
    tools: [
      {
        name: "lookup",
        description: "Look up a value",
        inputSchema: {
          type: "object",
          properties: { key: { type: "string" } },
          required: ["key"],
        },
      },
    ],
    jsonSchema: JSON.stringify({
      type: "object",
      properties: {
        result: { type: "string" },
      },
    }),
  };

  it("AnthropicDispatcher 미초기화 시 query 는 폴백 없이 실패한다", async () => {
    const dispatcher = new QgridDispatcherClass();

    await expect(
      dispatcher.query({ prompt: "hi", model: "anthropic/claude-sonnet-4-6" }),
    ).rejects.toMatchObject({ statusCode: 503 });
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
    ).rejects.toMatchObject({ statusCode: 503 });
  });

  // 기동 중과 초기화 실패는 클라이언트의 재시도 판단이 갈리는 지점이라 상태코드로 구분한다.
  it("기동 중 미준비는 503 으로 재시도 가능함을 알린다", async () => {
    const dispatcher = new QgridDispatcherClass();

    await expect(
      dispatcher.query({ prompt: "hi", model: "openai/gpt-5.4" }),
    ).rejects.toMatchObject({ statusCode: 503 });
  });

  it("초기화가 실패로 끝났으면 500 으로 재시도가 무의미함을 알린다", async () => {
    const dispatcher = new QgridDispatcherClass();
    dispatcher.startupState.openai = "failed";

    await expect(
      dispatcher.query({ prompt: "hi", model: "openai/gpt-5.4" }),
    ).rejects.toMatchObject({ statusCode: 500 });
  });

  it("provider 별로 기동 상태를 따로 본다", async () => {
    const dispatcher = new QgridDispatcherClass();
    dispatcher.startupState.openai = "failed";

    // openai 가 실패해도 anthropic 은 여전히 기동 중(재시도 가능)이다.
    await expect(
      dispatcher.query({ prompt: "hi", model: "anthropic/claude-sonnet-4-6" }),
    ).rejects.toMatchObject({ statusCode: 503 });
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
      { prompt: "hi", model: "anthropic/claude-sonnet-4-6", timeout: 360_000 },
      {
        onDelta: vi.fn(),
        onComplete: vi.fn(),
        onError: vi.fn(),
      },
      abortSignal,
    );

    expect(generateStream.mock.calls[0]![0].abortSignal).toBe(abortSignal);
    expect(generateStream.mock.calls[0]![0].timeoutMs).toBe(360_000);
  });

  it("Anthropic query 는 timeoutMs와 abortSignal을 provider request로 전달한다", async () => {
    const dispatcher = new QgridDispatcherClass();
    const generate = vi.fn(async (_req: GenerateRequest) =>
      providerResult({ model: "claude-opus-5" }),
    );
    dispatcher.anthropicDispatcher = { generate } as never;
    const abortSignal = new AbortController().signal;

    await dispatcher.query(
      { prompt: "hi", model: "anthropic/claude-opus-5", timeout: 360_000 },
      abortSignal,
    );

    expect(generate.mock.calls[0]![0]).toMatchObject({
      timeoutMs: 360_000,
      abortSignal,
    });
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

  it("OpenAI query 는 thread reuse 대신 full-history cache affinity 를 전달한다", async () => {
    const dispatcher = new QgridDispatcherClass();
    const generate = vi.fn(async (_req: GenerateRequest) => providerResult({ model: "gpt-5.5" }));
    dispatcher.openaiDispatcher = { generate } as never;

    await dispatcher.query({
      prompt: "next",
      model: "openai/gpt-5.5",
      system: "same-system",
      history: JSON.stringify([{ role: "user", content: "first" }]),
      cacheAffinityKey: "a".repeat(64),
      runContext: {
        threadCoord: {
          workerId: 1,
          threadId: "a".repeat(64),
          epoch: -1,
          systemHash: systemHash("same-system", "openai/gpt-5.5"),
        },
      },
    });

    const req = generate.mock.calls[0]![0];
    expect(req).not.toHaveProperty("reuse");
    expect(req).not.toHaveProperty("reuseInput");
    expect(req.coldHistory).toEqual([{ role: "user", content: "first" }]);
    expect(req.coldInput).toEqual([{ type: "text", text: "next", text_elements: [] }]);
    expect(req.promptCacheKey).toBe("a".repeat(64));
    expect(req.preferredTokenId).toBe(1);
  });

  it("OpenAI query 는 이름 해석으로 받은 내부 preferredTokenId 를 우선한다", async () => {
    const dispatcher = new QgridDispatcherClass();
    const generate = vi.fn(async (_req: GenerateRequest) => providerResult({ model: "gpt-5.5" }));
    dispatcher.openaiDispatcher = { generate } as never;

    await dispatcher.query({
      prompt: "targeted",
      model: "openai/gpt-5.5",
      preferredTokenId: 7,
      requirePreferredToken: true,
    });

    expect(generate.mock.calls[0]![0].preferredTokenId).toBe(7);
    expect(generate.mock.calls[0]![0].requirePreferredToken).toBe(true);
  });

  it("OpenAI response issues a four-field epoch=-1 affinity coord", async () => {
    const dispatcher = new QgridDispatcherClass();
    dispatcher.openaiDispatcher = {
      generate: vi.fn(async () =>
        providerResult({ threadCoord: { workerId: 137, threadId: "ignored", epoch: -1 } }),
      ),
    } as never;

    const result = await dispatcher.query({
      prompt: "first",
      model: "openai/gpt-5.5",
      system: "system",
      cacheAffinityKey: "c".repeat(64),
    });

    expect(result.runContext?.threadCoord).toEqual({
      workerId: 137,
      threadId: "c".repeat(64),
      epoch: -1,
      systemHash: expect.any(String),
    });
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

  it("Anthropic query 는 내부 preferredTokenId 를 provider 로 전달한다", async () => {
    const dispatcher = new QgridDispatcherClass();
    const generate = vi.fn(async (_req: GenerateRequest) =>
      providerResult({ model: "claude-sonnet-4-6" }),
    );
    dispatcher.anthropicDispatcher = { generate } as never;

    await dispatcher.query({
      prompt: "keepalive",
      model: "anthropic/claude-haiku-4-5",
      preferredTokenId: 7,
    });

    expect(generate.mock.calls[0]![0].preferredTokenId).toBe(7);
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

  it("Anthropic queryStream 은 내부 preferredTokenId 를 provider 로 전달한다", async () => {
    const dispatcher = new QgridDispatcherClass();
    const generateStream = vi.fn(async (_req, cb) => {
      cb.onComplete(providerResult({ model: "claude-sonnet-4-6" }));
    });
    dispatcher.anthropicDispatcher = { generateStream } as never;

    await dispatcher.queryStream(
      {
        prompt: "keepalive",
        model: "anthropic/claude-haiku-4-5",
        preferredTokenId: 7,
      },
      { onDelta: vi.fn(), onComplete: vi.fn(), onError: vi.fn() },
    );

    expect(generateStream.mock.calls[0]![0].preferredTokenId).toBe(7);
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

  it("tools + schema composition preserves prototype-sensitive keys through serialization", () => {
    const propertyNames = ["__proto__", "constructor", "prototype"];
    const properties = JSON.parse(
      '{"__proto__":{"type":"string"},"constructor":{"type":"integer"},"prototype":{"type":"boolean"}}',
    ) as Record<string, unknown>;
    const schema = buildStrictOutputSchema({
      tools: toolsAndSchema.tools,
      jsonSchema: JSON.stringify({
        type: "object",
        properties,
        required: propertyNames,
      }),
    }) as {
      $defs?: {
        __qgrid_user_output?: {
          properties?: Record<string, unknown>;
          required?: string[];
        };
      };
    };
    const strictUserSchema = schema.$defs?.__qgrid_user_output;
    const strictProperties = strictUserSchema?.properties;

    expect(strictUserSchema?.required).toEqual(propertyNames);
    for (const propertyName of propertyNames) {
      expect(Object.prototype.hasOwnProperty.call(strictProperties, propertyName)).toBe(true);
    }

    const serialized = JSON.stringify(schema);
    expect(serialized).toContain('"__proto__":{"type":"string"}');
    expect(serialized).toContain('"constructor":{"type":"integer"}');
    expect(serialized).toContain('"prototype":{"type":"boolean"}');
  });

  it.each([
    ["schema-only", undefined, deeplyNestedOutputSchema(5_000), "jsonSchema"],
    ["tools + schema", toolsAndSchema.tools, deeplyNestedOutputSchema(5_000), "jsonSchema"],
    [
      "tools-only",
      [
        {
          name: "deepTool",
          inputSchema: JSON.parse(deeplyNestedOutputSchema(5_000)) as unknown,
        },
      ],
      undefined,
      "tools[0].inputSchema",
    ],
  ])(
    "%s 경로에서 재귀 변환 전에 과도하게 깊은 caller schema를 거부한다",
    (_label, tools, jsonSchema, errorPath) => {
      expect(() => buildStrictOutputSchema({ jsonSchema, tools })).toThrow(
        `qgrid: ${errorPath} exceeds depth limit`,
      );
      try {
        buildStrictOutputSchema({ jsonSchema, tools });
      } catch (error) {
        expect(error).not.toBeInstanceOf(RangeError);
      }
    },
  );

  // SON-532: anthropic route 는 --json-schema 를 쓰지 않는다 — CC 의 강제 없는 사후 채점이
  // 소비자 의도와 충돌해 내부 재시도 루프를 발화시켰다. 스키마는 프롬프트로 안내되고
  // 판정은 소비자(zod)가 맡으므로 provider 로는 outputSchema 를 보내지 않는다.
  // (SON-495 의 "required 유지" 교훈은 채점 전제의 규칙이었다 — 안내문에는 소비자가
  // 선언한 required 가 원형 그대로 남는다.)
  it("Anthropic route 는 outputSchema 를 provider 로 전달하지 않는다", async () => {
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

    expect(generate.mock.calls[0]![0].outputSchema).toBeUndefined();
  });

  it("Anthropic route 도 원형 스키마의 구문·복잡도는 계속 검증한다", async () => {
    const dispatcher = new QgridDispatcherClass();
    dispatcher.anthropicDispatcher = { generate: vi.fn() } as never;

    // 구문 오류는 provider 실행 전에 caller-fault 로 거절된다.
    await expect(
      dispatcher.query({
        prompt: "hi",
        model: "anthropic/claude-sonnet-4-6",
        jsonSchema: "{not json",
      }),
    ).rejects.toThrow("jsonSchema must contain valid JSON");

    // 복잡도 한도(depth)도 그대로 산다.
    await expect(
      dispatcher.query({
        prompt: "hi",
        model: "anthropic/claude-sonnet-4-6",
        jsonSchema: deeplyNestedOutputSchema(5_000),
      }),
    ).rejects.toThrow("exceeds depth limit");
  });

  // SON-532: 계약은 --json-schema 대신 system 말미에 텍스트로 주입된다.
  it.each(["query", "queryStream"] as const)(
    "Anthropic %s 는 스키마 계약을 system prompt 말미에 합성해 전달한다",
    async (method) => {
      const dispatcher = new QgridDispatcherClass();
      let request: GenerateRequest | undefined;

      if (method === "query") {
        const generate = vi.fn(async (req: GenerateRequest) => {
          request = req;
          return providerResult();
        });
        dispatcher.anthropicDispatcher = { generate } as never;
        await dispatcher.query({
          prompt: "hi",
          system: "You are helpful.",
          model: "anthropic/claude-sonnet-4-6",
          jsonSchema: JSON.stringify({ type: "object", properties: { a: { type: "string" } } }),
        });
      } else {
        const generateStream = vi.fn(async (req: GenerateRequest, cb: GenerateStreamCallbacks) => {
          request = req;
          cb.onComplete(providerResult());
        });
        dispatcher.anthropicDispatcher = { generateStream } as never;
        await dispatcher.queryStream(
          {
            prompt: "hi",
            system: "You are helpful.",
            model: "anthropic/claude-sonnet-4-6",
            jsonSchema: JSON.stringify({ type: "object", properties: { a: { type: "string" } } }),
          },
          { onDelta: vi.fn(), onComplete: vi.fn(), onError: vi.fn() },
        );
      }

      // 원래 system 이 앞, 계약이 말미 — 스키마 원문이 그대로 들어간다.
      expect(request?.systemPrompt).toMatch(/^You are helpful\.\n\n## Output Format/);
      expect(request?.systemPrompt).toContain('"a":{"type":"string"}');
    },
  );

  it("Anthropic tools 요청은 envelope 계약을 system 에 합성한다", async () => {
    const dispatcher = new QgridDispatcherClass();
    const generate = vi.fn(async (req: GenerateRequest) => {
      void req;
      return providerResult({
        text: '{"result":{"action":"answer","answer":{"payload":"ok"},"toolCalls":null}}',
      });
    });
    dispatcher.anthropicDispatcher = { generate } as never;

    await dispatcher.query({ prompt: "hi", model: "anthropic/claude-sonnet-4-6", ...toolsAndSchema });

    const request = generate.mock.calls[0]![0];
    expect(request.systemPrompt).toContain("## Client Tool Protocol");
    expect(request.systemPrompt).toContain('{"result": ...}');
    expect(request.systemPrompt).toContain("- lookup");
  });

  it("스키마 없는 Anthropic 요청은 system 을 그대로 둔다", async () => {
    const dispatcher = new QgridDispatcherClass();
    const generate = vi.fn(async (_req: GenerateRequest) => providerResult());
    dispatcher.anthropicDispatcher = { generate } as never;

    await dispatcher.query({ prompt: "hi", system: "plain", model: "anthropic/claude-sonnet-4-6" });
    expect(generate.mock.calls[0]![0]!.systemPrompt).toBe("plain");

    await dispatcher.query({ prompt: "hi", model: "anthropic/claude-sonnet-4-6" });
    expect(generate.mock.calls[1]![0]!.systemPrompt).toBeUndefined();
  });

  it("OpenAI 요청의 system 에는 계약을 합성하지 않는다", async () => {
    const dispatcher = new QgridDispatcherClass();
    const generate = vi.fn(async (_req: GenerateRequest) =>
      providerResult({ text: '{"a":"ok"}' }),
    );
    dispatcher.openaiDispatcher = { generate } as never;

    await dispatcher.query({
      prompt: "hi",
      system: "plain",
      model: "openai/gpt-5.5",
      jsonSchema: JSON.stringify({ type: "object", properties: { a: { type: "string" } } }),
    });

    expect(generate.mock.calls[0]![0]!.systemPrompt).toBe("plain");
  });

  // SON-532: 계약 주입 스트림의 델타에서 펜스를 벗긴다. 클라이언트(EnvelopeStreamParser,
  // partialOutputStream)는 펜스를 처리하지 못하므로 서버 책임이다.
  it("Anthropic 스트림은 계약 주입 시 델타의 코드펜스를 벗겨 방출한다", async () => {
    const dispatcher = new QgridDispatcherClass();
    const generateStream = vi.fn(async (_req: GenerateRequest, cb: GenerateStreamCallbacks) => {
      cb.onDelta("```json\n");
      cb.onDelta('{"a"');
      cb.onDelta(":1}");
      cb.onDelta("\n```");
      cb.onComplete(providerResult({ text: '{"a":1}' }));
    });
    dispatcher.anthropicDispatcher = { generateStream } as never;

    const deltas: string[] = [];
    let completed: QueryOutput | undefined;
    await dispatcher.queryStream(
      {
        prompt: "hi",
        model: "anthropic/claude-sonnet-4-6",
        jsonSchema: JSON.stringify({ type: "object", properties: { a: { type: "number" } } }),
      },
      {
        onDelta: (t) => deltas.push(t),
        onComplete: (output) => {
          completed = output;
        },
        onError: vi.fn(),
      },
    );

    // 델타 연결 == 펜스 벗긴 전체 텍스트 == done.text (adapter 의 stripFences 와 동일 시맨틱)
    expect(deltas.join("")).toBe('{"a":1}');
    expect(completed?.text).toBe('{"a":1}');
  });

  it("Anthropic 스트림의 홀드백 잔여는 done 전에 방출된다 (내용 무손실)", async () => {
    const dispatcher = new QgridDispatcherClass();
    const events: string[] = [];
    const generateStream = vi.fn(async (_req: GenerateRequest, cb: GenerateStreamCallbacks) => {
      cb.onDelta('{"a":1}\n``'); // 미완성 펜스로 종료 — 닫는 펜스가 아니다
      cb.onComplete(providerResult({ text: '{"a":1}\n``' }));
    });
    dispatcher.anthropicDispatcher = { generateStream } as never;

    await dispatcher.queryStream(
      {
        prompt: "hi",
        model: "anthropic/claude-sonnet-4-6",
        jsonSchema: JSON.stringify({ type: "object" }),
      },
      {
        onDelta: (t) => events.push(`delta:${t}`),
        onComplete: () => events.push("complete"),
        onError: vi.fn(),
      },
    );

    expect(events.join("|")).toBe('delta:{"a":1}|delta:\n``|complete');
  });

  it("계약 없는 Anthropic 스트림 델타는 무변경 통과한다", async () => {
    const dispatcher = new QgridDispatcherClass();
    const generateStream = vi.fn(async (_req: GenerateRequest, cb: GenerateStreamCallbacks) => {
      cb.onDelta("```python\ncode\n```");
      cb.onComplete(providerResult({ text: "```python\ncode\n```" }));
    });
    dispatcher.anthropicDispatcher = { generateStream } as never;

    const deltas: string[] = [];
    await dispatcher.queryStream(
      { prompt: "hi", model: "anthropic/claude-sonnet-4-6" },
      { onDelta: (t) => deltas.push(t), onComplete: vi.fn(), onError: vi.fn() },
    );

    expect(deltas.join("")).toBe("```python\ncode\n```");
  });

  it("Anthropic route 는 strict 전용 argv 64KiB 제한을 적용하지 않는다", async () => {
    const dispatcher = new QgridDispatcherClass();
    const generate = vi.fn(async (): Promise<GenerateResult> => providerResult());
    dispatcher.anthropicDispatcher = { generate } as never;

    // 64KiB(ANTHROPIC_SCHEMA_ARGV_MAX_UTF8_BYTES) 초과, 전역 512KiB 미만 스키마.
    // structured 시절에는 argv 제한으로 거절됐지만 프롬프트 전달은 system 크기 분기가 흡수한다.
    const bigSchema = JSON.stringify({
      type: "object",
      description: "x".repeat(80 * 1024),
      properties: { value: { type: "string" } },
    });

    await expect(
      dispatcher.query({
        prompt: "hi",
        model: "anthropic/claude-sonnet-4-6",
        jsonSchema: bigSchema,
      }),
    ).resolves.toBeDefined();
    expect(generate).toHaveBeenCalledOnce();
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

  it("tools + jsonSchema 를 합성하고 user $defs까지 strictify 한다", () => {
    const schema = buildStrictOutputSchema({
      tools: toolsAndSchema.tools,
      jsonSchema: JSON.stringify({
        type: "object",
        properties: { item: { $ref: "#/$defs/Item" } },
        $defs: {
          Item: {
            type: "object",
            properties: {
              value: { type: "string" },
              optionalNote: { type: "string" },
            },
            required: ["value"],
          },
        },
      }),
    }) as {
      properties?: {
        result?: {
          anyOf?: Array<{ properties?: { answer?: { $ref?: string } } }>;
        };
      };
      $defs?: {
        __qgrid_user_output?: {
          required?: string[];
          additionalProperties?: boolean;
          properties?: { item?: { anyOf?: Array<{ $ref?: string }> } };
          $defs?: {
            Item?: {
              required?: string[];
              additionalProperties?: boolean;
              properties?: { optionalNote?: { anyOf?: unknown[] } };
            };
          };
        };
      };
    };
    const userSchema = schema.$defs?.__qgrid_user_output;

    expect(schema.properties?.result?.anyOf?.[0]?.properties?.answer?.$ref).toBe(
      "#/$defs/__qgrid_user_output",
    );
    expect(userSchema).toMatchObject({
      required: ["item"],
      additionalProperties: false,
      properties: {
        item: {
          anyOf: [
            { $ref: "#/$defs/__qgrid_user_output/$defs/Item" },
            { type: "null" },
          ],
        },
      },
    });
    expect(userSchema?.$defs?.Item).toMatchObject({
      required: ["value", "optionalNote"],
      additionalProperties: false,
    });
    expect(userSchema?.$defs?.Item?.properties?.optionalNote?.anyOf).toEqual([
      { type: "string" },
      { type: "null" },
    ]);
  });

  it("tools + jsonSchema 합성 경로에서 prefixItems tuple 구성원도 strictify 한다", () => {
    const schema = buildStrictOutputSchema({
      tools: toolsAndSchema.tools,
      jsonSchema: JSON.stringify({
        type: "object",
        properties: {
          tuple: {
            type: "array",
            prefixItems: [
              {
                type: "object",
                properties: { label: { type: "string" } },
                required: ["label"],
              },
              { type: "integer" },
            ],
            minItems: 2,
            maxItems: 2,
          },
        },
        required: ["tuple"],
      }),
    }) as {
      $defs?: {
        __qgrid_user_output?: {
          properties?: {
            tuple?: {
              prefixItems?: Array<{
                required?: string[];
                additionalProperties?: boolean;
              }>;
            };
          };
        };
      };
    };

    expect(
      schema.$defs?.__qgrid_user_output?.properties?.tuple?.prefixItems?.[0],
    ).toMatchObject({
      required: ["label"],
      additionalProperties: false,
    });
  });

  it("OpenAI tools + draft-07 tuple schema를 위치 제약을 보존해 정규화한다", () => {
    const schema = buildStrictOutputSchema(
      {
        tools: toolsAndSchema.tools,
        jsonSchema: JSON.stringify({
          $schema: "http://json-schema.org/draft-07/schema#",
          type: "object",
          properties: {
            tuple: {
              type: "array",
              items: [
                {
                  type: "object",
                  properties: { label: { type: "string" } },
                },
                { type: "integer" },
              ],
            },
          },
          required: ["tuple"],
        }),
      },
      "openai",
    ) as {
      $defs?: {
        __qgrid_user_output?: {
          properties?: {
            tuple?: {
              items?: unknown;
              prefixItems?: unknown[];
              minItems?: number;
              maxItems?: number;
            };
          };
        };
      };
    };
    const tuple = schema.$defs?.__qgrid_user_output?.properties?.tuple;

    expect(tuple).toMatchObject({
      minItems: 2,
      maxItems: 2,
    });
    expect(Array.isArray(tuple?.items)).toBe(false);
    expect(tuple?.prefixItems).toHaveLength(2);
  });

  it("Anthropic tools + positional tuple schema는 의미를 약화하지 않고 거부한다", () => {
    expect(() =>
      buildStrictOutputSchema(
        {
          tools: toolsAndSchema.tools,
          jsonSchema: JSON.stringify({
            type: "object",
            properties: {
              tuple: {
                type: "array",
                items: [{ type: "string" }, { type: "integer" }],
              },
            },
            required: ["tuple"],
          }),
        },
        "anthropic",
      ),
    ).toThrow(/positional tuple schemas are not supported on Anthropic/);
  });

  it.each([
    ["openai", "query"],
    ["openai", "queryStream"],
    ["anthropic", "query"],
    ["anthropic", "queryStream"],
  ] as const)(
    // openai 는 composed strict envelope 를 provider 로 보내고, anthropic 은 보내지 않는다
    // (SON-532 — envelope 계약은 프롬프트로 안내). 응답 해석(emulation)은 양쪽 동일하다.
    "%s %s tools + jsonSchema 경로: outputSchema 전달 계약과 envelope 해석",
    async (provider, method) => {
      const dispatcher = new QgridDispatcherClass();
      const model =
        provider === "openai" ? "openai/gpt-5.5" : "anthropic/claude-sonnet-4-6";
      let request: GenerateRequest | undefined;
      let mappedText: string | undefined;

      if (method === "query") {
        const generate = vi.fn(async (req: GenerateRequest) => {
          request = req;
          return providerResult({
            text: '{"result":{"action":"answer","answer":{"payload":"ok"},"toolCalls":null}}',
          });
        });
        if (provider === "openai") dispatcher.openaiDispatcher = { generate } as never;
        else dispatcher.anthropicDispatcher = { generate } as never;

        const output = await dispatcher.query({ prompt: "hi", model, ...toolsAndSchema });
        mappedText = output.text;
      } else {
        const generateStream = vi.fn(
          async (req: GenerateRequest, cb: GenerateStreamCallbacks) => {
            request = req;
            cb.onComplete(
              providerResult({
                text: '{"result":{"action":"answer","answer":{"payload":"ok"},"toolCalls":null}}',
              }),
            );
          },
        );
        if (provider === "openai") {
          dispatcher.openaiDispatcher = { generateStream } as never;
        } else {
          dispatcher.anthropicDispatcher = { generateStream } as never;
        }

        await dispatcher.queryStream(
          { prompt: "hi", model, ...toolsAndSchema },
          {
            onDelta: vi.fn(),
            onComplete: (output) => {
              mappedText = output.text;
            },
            onError: vi.fn(),
          },
        );
      }

      if (provider === "openai") {
        expect(request?.outputSchema).toMatchObject({
          properties: {
            result: {
              anyOf: [
                {
                  properties: {
                    action: { enum: ["answer"] },
                    answer: { $ref: "#/$defs/__qgrid_user_output" },
                  },
                },
                {
                  properties: {
                    action: { enum: ["tool_call"] },
                    toolCalls: { minItems: 1 },
                  },
                },
              ],
            },
          },
          $defs: {
            __qgrid_user_output: {
              type: "object",
              required: ["result"],
              additionalProperties: false,
            },
          },
        });
      } else {
        expect(request?.outputSchema).toBeUndefined();
      }
      expect(mappedText).toBe('{"payload":"ok"}');
    },
  );

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
