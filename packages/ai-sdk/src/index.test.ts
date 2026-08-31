import { afterEach, describe, expect, it, vi } from "vitest";

import { qgrid } from "./index";

const usage = {
  input_tokens: 10,
  output_tokens: 5,
  reasoning_tokens: 2,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 3,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function tool() {
  return {
    type: "function",
    name: "getWeather",
    description: "Get weather",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  };
}

const structuredOutputSchema = {
  type: "object",
  properties: { result: { type: "string" } },
  required: ["result"],
  additionalProperties: false,
};

function toolPrompt(callIds: string[]) {
  return [
    { role: "user", content: [{ type: "text", text: "weather" }] },
    ...callIds.flatMap((callId) => [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: callId,
            toolName: "getWeather",
            input: { city: callId },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: callId,
            output: { temperature: callId },
          },
        ],
      },
    ]),
  ];
}

function sseDone(data: unknown) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`event: done\ndata: ${JSON.stringify(data)}\n\n`));
      controller.close();
    },
  });
}

describe("qgrid AI SDK provider", () => {
  it("rejects an explicitly empty tokenName before generate or stream transport", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const model = qgrid("anthropic/claude-fable-5");
    const options = {
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      providerOptions: { qgrid: { tokenName: "" } },
    } as never;

    await expect(model.doGenerate(options)).rejects.toThrow(/tokenName must not be empty/);
    await expect(model.doStream(options)).rejects.toThrow(/tokenName must not be empty/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends QGRID_PROJECT_NAME for provider request logs", async () => {
    vi.stubEnv("QGRID_PROJECT_NAME", "deti");
    let queryBody: unknown;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/query")) {
          queryBody = JSON.parse(String(init?.body));
          return new Response(
            JSON.stringify({
              text: "ok",
              model: "gpt-5.5",
              usage,
              durationMs: 50,
              costUsd: 0.001,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}", { status: 200 });
      }),
    );

    await qgrid("openai/gpt-5.5").doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    } as never);

    expect(queryBody).toMatchObject({
      args: {
        projectName: "deti",
      },
    });
  });

  it("sends qgrid provider options", async () => {
    let queryBody: unknown;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/query")) {
          queryBody = JSON.parse(String(init?.body));
          return new Response(
            JSON.stringify({
              text: "ok",
              model: "gpt-5.5",
              usage,
              durationMs: 50,
              costUsd: 0.001,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}", { status: 200 });
      }),
    );

    await qgrid("openai/gpt-5.5", { defaultEffort: "low" }).doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      providerOptions: {
        qgrid: {
          effort: "high",
          verbosity: "medium",
          reasoningSummary: "concise",
          serviceTier: "flex",
          timeoutMs: 360_000,
          logger: false,
          tokenName: "openai/yds",
          fallbackModels: ["openai/gpt-5.4-mini"],
        },
      },
    } as never);

    expect(queryBody).toMatchObject({
      args: {
        effort: "high",
        verbosity: "medium",
        reasoningSummary: "concise",
        serviceTier: "flex",
        timeout: 360_000,
        logger: false,
        tokenName: "openai/yds",
      },
    });
    expect((queryBody as { args: Record<string, unknown> }).args).not.toHaveProperty(
      "fallbackModels",
    );
  });

  it("uses a request-scoped dispatcher for Anthropic generate requests", async () => {
    let requestInit: RequestInit | undefined;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        requestInit = init;
        return new Response(
          JSON.stringify({
            text: "ok",
            model: "claude-sonnet-4-7",
            usage,
            durationMs: 310_000,
            costUsd: 0.01,
            costSource: "provider",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    await qgrid("anthropic/claude-sonnet-4-7").doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "slow request" }] }],
      providerOptions: { qgrid: { timeoutMs: 600_000 } },
    } as never);

    expect(requestInit).toHaveProperty("dispatcher");
    expect(
      (requestInit as RequestInit & { dispatcher: { closed: boolean } }).dispatcher.closed,
    ).toBe(true);
  });

  it("does not replace the dispatcher for OpenAI generate requests", async () => {
    let requestInit: RequestInit | undefined;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        requestInit = init;
        return new Response(
          JSON.stringify({
            text: "ok",
            model: "gpt-5.6-terra",
            usage,
            durationMs: 50,
            costUsd: 0.001,
            costSource: "provider",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    await qgrid("openai/gpt-5.6-terra").doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "fast request" }] }],
    } as never);

    expect(requestInit).not.toHaveProperty("dispatcher");
  });

  it("identifies an Anthropic response headers timeout and reports its transport budget", async () => {
    const cause = Object.assign(new Error("Headers Timeout Error"), {
      code: "UND_ERR_HEADERS_TIMEOUT",
    });
    let dispatcher: { closed: boolean } | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit & { dispatcher?: { closed: boolean } }) => {
        dispatcher = init?.dispatcher;
        throw new TypeError("fetch failed", { cause });
      }),
    );

    await expect(
      qgrid("anthropic/claude-sonnet-4-7").doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "slow request" }] }],
        providerOptions: { qgrid: { timeoutMs: 600_000 } },
      } as never),
    ).rejects.toThrow(
      "qgrid query transport failed: response headers timed out after 660000ms (UND_ERR_HEADERS_TIMEOUT)",
    );
    expect(dispatcher?.closed).toBe(true);
  });

  it("distinguishes connection refusal from a response headers timeout", async () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:44900"), {
      code: "ECONNREFUSED",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed", { cause });
      }),
    );

    await expect(
      qgrid("anthropic/claude-sonnet-4-7").doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "request" }] }],
      } as never),
    ).rejects.toThrow(
      "qgrid query transport failed: connection refused by http://localhost:44900 (ECONNREFUSED)",
    );
  });

  it("sends tools and maps tool-call response", async () => {
    let queryBody: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (url.includes("/query")) {
          queryBody = body;
          return new Response(
            JSON.stringify({
              text: "",
              content: [
                {
                  type: "tool-call",
                  toolCallId: "call_weather",
                  toolName: "getWeather",
                  input: JSON.stringify({ city: "Seoul" }),
                },
              ],
              finishReason: "tool-calls",
              model: "gpt-5.5",
              usage,
              durationMs: 100,
              costUsd: 0.01,
              runContext: { requestLogId: 1 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}", { status: 200 });
      }),
    );

    const result = await qgrid("openai/gpt-5.5").doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "weather" }] }],
      tools: [tool()],
    } as never);

    expect(queryBody).toMatchObject({
      args: {
        prompt: "weather",
        tools: [{ name: "getWeather", description: "Get weather" }],
      },
    });
    expect((queryBody as { args: Record<string, unknown> }).args).not.toHaveProperty("logMode");
    expect((queryBody as { args: Record<string, unknown> }).args).not.toHaveProperty("jsonSchema");
    expect(result.finishReason).toEqual({ unified: "tool-calls", raw: "tool_call" });
    expect(result.usage.outputTokens).toEqual({ total: 5, text: 3, reasoning: 2 });
    expect(result.content).toEqual([
      {
        type: "tool-call",
        toolCallId: "call_weather",
        toolName: "getWeather",
        input: JSON.stringify({ city: "Seoul" }),
      },
    ]);
  });

  it("sends tools and structured output together in an exact generate payload", async () => {
    let queryArgs: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/query")) {
          queryArgs = JSON.parse(String(init?.body)).args;
          return new Response(
            JSON.stringify({
              text: '{"result":"ok"}',
              content: [{ type: "text", text: '{"result":"ok"}' }],
              finishReason: "stop",
              model: "gpt-5.6-terra",
              usage,
              durationMs: 50,
              costUsd: 0.001,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}", { status: 200 });
      }),
    );

    await qgrid("openai/gpt-5.6-terra").doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "weather" }] }],
      tools: [tool()],
      responseFormat: { type: "json", schema: structuredOutputSchema },
    } as never);

    expect(queryArgs).toEqual({
      prompt: "weather",
      model: "openai/gpt-5.6-terra",
      effort: "low",
      tools: [
        {
          name: "getWeather",
          description: "Get weather",
          inputSchema: tool().inputSchema,
        },
      ],
      jsonSchema: JSON.stringify(structuredOutputSchema),
    });
  });

  it("keeps schema-only generate payloads free of tools", async () => {
    let queryArgs: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/query")) {
          queryArgs = JSON.parse(String(init?.body)).args;
          return new Response(
            JSON.stringify({
              text: '{"result":"ok"}',
              model: "gpt-5.6-terra",
              usage,
              durationMs: 50,
              costUsd: 0.001,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}", { status: 200 });
      }),
    );

    await qgrid("openai/gpt-5.6-terra").doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "answer" }] }],
      responseFormat: { type: "json", schema: structuredOutputSchema },
    } as never);

    expect(queryArgs).toEqual({
      prompt: "answer",
      model: "openai/gpt-5.6-terra",
      effort: "low",
      jsonSchema: JSON.stringify(structuredOutputSchema),
    });
  });

  it("sends runContext and toolResults on tool-call follow-up", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        calls.push({ url, body });

        if (url.includes("/query")) {
          const prompt = body.args.prompt as string;
          if (prompt === "weather") {
            return new Response(
              JSON.stringify({
                text: "",
                content: [
                  {
                    type: "tool-call",
                    toolCallId: "call_1",
                    toolName: "getWeather",
                    input: '{"city":"Seoul"}',
                  },
                ],
                finishReason: "tool-calls",
                model: "gpt-5.5",
                usage,
                durationMs: 100,
                costUsd: 0.01,
                runContext: { requestLogId: 42 },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          // follow-up (stop)
          return new Response(
            JSON.stringify({
              text: '{"result":"Seoul is 22°C"}',
              content: [{ type: "text", text: '{"result":"Seoul is 22°C"}' }],
              finishReason: "stop",
              model: "gpt-5.5",
              usage,
              durationMs: 80,
              costUsd: 0.005,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}", { status: 200 });
      }),
    );

    const model = qgrid("openai/gpt-5.5");

    // 턴 1: tool-calls
    await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "weather" }] }],
      tools: [tool()],
      responseFormat: { type: "json", schema: structuredOutputSchema },
    } as never);

    // 턴 2: follow-up with tool result
    const result = await model.doGenerate({
      prompt: toolPrompt(["call_1"]),
      tools: [tool()],
      responseFormat: { type: "json", schema: structuredOutputSchema },
    } as never);

    // follow-up 호출에 runContext + toolResults가 포함되어야 함
    const followUpQuery = calls.filter((c) => c.url.includes("/query"))[1];
    expect(followUpQuery?.body.args).toMatchObject({
      runContext: { requestLogId: 42 },
      toolResults: [{ toolCallId: "call_1" }],
    });
    expect(followUpQuery?.body.args).not.toHaveProperty("logMode");
    const queryArgs = calls
      .filter((c) => c.url.includes("/query"))
      .map((c) => c.body.args as Record<string, unknown>);
    expect(queryArgs).toHaveLength(2);
    expect(queryArgs[0]?.jsonSchema).toBe(JSON.stringify(structuredOutputSchema));
    expect(queryArgs[1]?.jsonSchema).toBe(JSON.stringify(structuredOutputSchema));

    // SDK는 직접 createRun/appendStep/finishRun 호출 안 함
    expect(calls.filter((c) => c.url.includes("/createRun"))).toHaveLength(0);
    expect(calls.filter((c) => c.url.includes("/appendStep"))).toHaveLength(0);
    expect(calls.filter((c) => c.url.includes("/finishRun"))).toHaveLength(0);

    expect(result.content).toEqual([{ type: "text", text: '{"result":"Seoul is 22°C"}' }]);
  });

  it("continues logger-disabled image generation through a client tool without runContext", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        calls.push({ url, body });

        if (!url.includes("/query")) return new Response("{}", { status: 200 });

        if (Array.isArray(body.args.toolResults)) {
          return new Response(
            JSON.stringify({
              text: "",
              content: [{ type: "image", data: "iVBORw0KGgoBAgM", revisedPrompt: null }],
              finishReason: "stop",
              model: "gpt-5.4",
              usage,
              durationMs: 80,
              costUsd: 0.005,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        return new Response(
          JSON.stringify({
            text: "",
            content: [
              {
                type: "tool-call",
                toolCallId: "call_palette",
                toolName: "getWeather",
                input: '{"city":"palette"}',
              },
            ],
            finishReason: "tool-calls",
            model: "gpt-5.5",
            usage,
            durationMs: 100,
            costUsd: 0.01,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const model = qgrid("openai/gpt-5.5");
    const providerOptions = { qgrid: { imageGeneration: true, logger: false } };

    const first = await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "draw with this palette" }] }],
      tools: [tool()],
      providerOptions,
    } as never);
    expect(first.finishReason).toEqual({ unified: "tool-calls", raw: "tool_call" });

    const result = await model.doGenerate({
      prompt: toolPrompt(["call_palette"]),
      tools: [tool()],
      providerOptions,
    } as never);

    const queryBodies = calls.filter((call) => call.url.includes("/query")).map((call) => call.body);
    expect(queryBodies).toHaveLength(2);
    expect(queryBodies[0]?.args).toMatchObject({
      logger: false,
      imageGeneration: true,
    });
    expect(queryBodies[1]?.args).toMatchObject({
      logger: false,
      imageGeneration: true,
      toolResults: [{ toolCallId: "call_palette" }],
    });
    expect(queryBodies[1]?.args).not.toHaveProperty("runContext");
    expect(result.content).toEqual([
      { type: "file", mediaType: "image/png", data: "iVBORw0KGgoBAgM" },
    ]);
    expect(result.response?.modelId).toBe("gpt-5.4");
  });

  it("keeps parallel logger-disabled tool runs isolated without server run contexts", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        calls.push({ url, body });

        if (url.includes("/query")) {
          if (Array.isArray(body.args.toolResults)) {
            const toolCallId = body.args.toolResults[0]?.toolCallId;
            return new Response(
              JSON.stringify({
                text: `done ${toolCallId}`,
                content: [{ type: "text", text: `done ${toolCallId}` }],
                finishReason: "stop",
                model: "gpt-5.5",
                usage,
                durationMs: 80,
                costUsd: 0.005,
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }

          const prompt = body.args.prompt as string;
          const suffix = prompt.endsWith("a") ? "a" : "b";
          return new Response(
            JSON.stringify({
              text: "",
              content: [
                {
                  type: "tool-call",
                  toolCallId: `call_${suffix}`,
                  toolName: "getWeather",
                  input: JSON.stringify({ city: suffix }),
                },
              ],
              finishReason: "tool-calls",
              model: "gpt-5.5",
              usage,
              durationMs: 100,
              costUsd: 0.01,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}", { status: 200 });
      }),
    );

    const model = qgrid("openai/gpt-5.5");

    await Promise.all([
      model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "weather a" }] }],
        tools: [tool()],
        providerOptions: { qgrid: { logger: false } },
      } as never),
      model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "weather b" }] }],
        tools: [tool()],
        providerOptions: { qgrid: { logger: false } },
      } as never),
    ]);

    await model.doGenerate({
      prompt: toolPrompt(["call_a"]),
      tools: [tool()],
      providerOptions: { qgrid: { logger: false } },
    } as never);
    await model.doGenerate({
      prompt: toolPrompt(["call_b"]),
      tools: [tool()],
      providerOptions: { qgrid: { logger: false } },
    } as never);

    const queryBodies = calls
      .filter((c) => c.url.includes("/query"))
      .map((c) => c.body as { args: { toolResults?: Array<{ toolCallId: string }> } });
    const followUpA = queryBodies.find((body) =>
      JSON.stringify(body.args.toolResults ?? []).includes("call_a"),
    );
    const followUpB = queryBodies.find((body) =>
      JSON.stringify(body.args.toolResults ?? []).includes("call_b"),
    );

    expect(followUpA?.args).toMatchObject({
      logger: false,
      toolResults: [{ toolCallId: "call_a" }],
    });
    expect(followUpB?.args).toMatchObject({
      logger: false,
      toolResults: [{ toolCallId: "call_b" }],
    });
    expect(followUpA?.args).not.toHaveProperty("runContext");
    expect(followUpB?.args).not.toHaveProperty("runContext");
  });

  it("keeps request logging enabled by default without sending a wire override", async () => {
    let queryBody: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        if (url.includes("/query")) {
          queryBody = body;
          return new Response(
            JSON.stringify({
              text: "hello",
              content: [{ type: "text", text: "hello" }],
              finishReason: "stop",
              model: "gpt-5.5",
              usage,
              durationMs: 50,
              costUsd: 0.001,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}", { status: 200 });
      }),
    );

    await qgrid("openai/gpt-5.5").doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    } as never);

    expect((queryBody as Record<string, unknown>).args).not.toHaveProperty("logMode");
    expect((queryBody as Record<string, unknown>).args).not.toHaveProperty("logger");
  });

  it("maps usage without negative noCache tokens when cache read is present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/query")) {
          return new Response(
            JSON.stringify({
              text: "cached",
              content: [{ type: "text", text: "cached" }],
              finishReason: "stop",
              model: "claude-sonnet-4-6",
              usage: {
                input_tokens: 1081,
                output_tokens: 5,
                cache_creation_input_tokens: 10,
                cache_read_input_tokens: 1068,
              },
              durationMs: 50,
              costUsd: 0.001,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}", { status: 200 });
      }),
    );

    const result = await qgrid("anthropic/claude-sonnet-4-6").doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    } as never);

    expect(result.usage.inputTokens).toEqual({
      total: 1081,
      noCache: 3,
      cacheRead: 1068,
      cacheWrite: 10,
    });
  });

  it("exposes Fable refusal fallback routing and cost provenance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/query")) {
          return new Response(
            JSON.stringify({
              text: "served by opus",
              content: [{ type: "text", text: "served by opus" }],
              finishReason: "stop",
              model: "claude-opus-4-8",
              requestedModel: "claude-fable-5",
              modelFallbacks: [
                {
                  trigger: "refusal",
                  fromModel: "claude-fable-5",
                  toModel: "claude-opus-4-8",
                  category: "cyber",
                },
              ],
              usage: {
                ...usage,
                cache_creation_5m_input_tokens: 2,
                cache_creation_1h_input_tokens: 7,
              },
              durationMs: 50,
              costUsd: 0.003,
              costSource: "provider",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}", { status: 200 });
      }),
    );

    const result = await qgrid("anthropic/claude-fable-5").doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    } as never);

    expect(result.response?.modelId).toBe("claude-opus-4-8");
    expect(result.providerMetadata?.qgrid).toMatchObject({
      model: "claude-opus-4-8",
      requestedModel: "claude-fable-5",
      costSource: "provider",
      cacheCreation5mInputTokens: 2,
      cacheCreation1hInputTokens: 7,
      modelFallbacks: [
        {
          trigger: "refusal",
          fromModel: "claude-fable-5",
          toModel: "claude-opus-4-8",
        },
      ],
    });
  });

  it("sends logger false to prepareStream", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        calls.push({ url, body });

        if (url.includes("/prepareStream")) {
          return new Response(JSON.stringify({ streamId: "s1" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("/queryStream")) {
          return new Response(
            sseDone({
              text: "streamed",
              content: [{ type: "text", text: "streamed" }],
              finishReason: "stop",
              model: "gpt-5.5",
              usage,
              durationMs: 100,
              costUsd: 0.01,
            }),
            { status: 200 },
          );
        }
        return new Response("{}", { status: 200 });
      }),
    );

    const result = await qgrid("openai/gpt-5.5").doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      providerOptions: {
        qgrid: { logger: false, timeoutMs: 360_000, tokenName: "openai/yds" },
      },
    } as never);
    for await (const _part of result.stream) {
      // drain
    }

    const prepareCall = calls.find((c) => c.url.includes("/prepareStream"));
    expect(prepareCall?.body.args).toMatchObject({
      logger: false,
      timeout: 360_000,
      tokenName: "openai/yds",
    });
    expect(prepareCall?.body.args).not.toHaveProperty("logMode");

    // SDK는 직접 lifecycle 호출 안 함
    expect(calls.filter((c) => c.url.includes("/createRun"))).toHaveLength(0);
    expect(calls.filter((c) => c.url.includes("/finishRun"))).toHaveLength(0);
  });

  it("sends tools and structured output together in an exact stream prepare payload", async () => {
    let prepareArgs: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/prepareStream")) {
          prepareArgs = JSON.parse(String(init?.body)).args;
          return new Response(JSON.stringify({ streamId: "combined-schema" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("/queryStream")) {
          return new Response(
            sseDone({
              text: '{"result":"ok"}',
              content: [{ type: "text", text: '{"result":"ok"}' }],
              finishReason: "stop",
              model: "gpt-5.6-terra",
              usage,
              durationMs: 50,
              costUsd: 0.001,
            }),
            { status: 200 },
          );
        }
        return new Response("{}", { status: 200 });
      }),
    );

    const result = await qgrid("openai/gpt-5.6-terra").doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "weather" }] }],
      tools: [tool()],
      responseFormat: { type: "json", schema: structuredOutputSchema },
    } as never);
    for await (const _part of result.stream) {
      // drain
    }

    expect(prepareArgs).toEqual({
      prompt: "weather",
      model: "openai/gpt-5.6-terra",
      effort: "low",
      tools: [
        {
          name: "getWeather",
          description: "Get weather",
          inputSchema: tool().inputSchema,
        },
      ],
      jsonSchema: JSON.stringify(structuredOutputSchema),
    });
  });

  it.each([
    ["generate", false, { type: "array", items: { type: "string" } }, "array"],
    ["generate", true, { type: "array", items: { type: "string" } }, "array"],
    ["stream", false, { type: "array", items: { type: "string" } }, "array"],
    ["stream", true, { type: "array", items: { type: "string" } }, "array"],
    ["generate", false, false, "unknown"],
    ["generate", true, false, "unknown"],
    ["stream", false, false, "unknown"],
    ["stream", true, false, "unknown"],
    ["generate", false, true, "unknown"],
    ["generate", true, true, "unknown"],
    ["stream", false, true, "unknown"],
    ["stream", true, true, "unknown"],
  ] as const)(
    "warns and omits unsupported top-level schemas consistently for %s (tools=%s, schema=%j)",
    async (mode, withTools, unsupportedSchema, expectedType) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      let args: Record<string, unknown> | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (url.includes("/query") && !url.includes("/queryStream")) {
            args = JSON.parse(String(init?.body)).args;
            return new Response(
              JSON.stringify({
                text: "ok",
                content: [{ type: "text", text: "ok" }],
                finishReason: "stop",
                model: "gpt-5.6-terra",
                usage,
                durationMs: 10,
                costUsd: 0,
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          if (url.includes("/prepareStream")) {
            args = JSON.parse(String(init?.body)).args;
            return new Response(JSON.stringify({ streamId: "unsupported-schema" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          if (url.includes("/queryStream")) {
            return new Response(
              sseDone({
                text: "ok",
                content: [{ type: "text", text: "ok" }],
                finishReason: "stop",
                model: "gpt-5.6-terra",
                usage,
                durationMs: 10,
                costUsd: 0,
              }),
              { status: 200 },
            );
          }
          return new Response("{}", { status: 200 });
        }),
      );

      const options = {
        prompt: [{ role: "user", content: [{ type: "text", text: "answer" }] }],
        ...(withTools ? { tools: [tool()] } : {}),
        responseFormat: {
          type: "json",
          schema: unsupportedSchema,
        },
      } as never;

      if (mode === "generate") {
        await qgrid("openai/gpt-5.6-terra").doGenerate(options);
      } else {
        const result = await qgrid("openai/gpt-5.6-terra").doStream(options);
        for await (const _part of result.stream) {
          // drain
        }
      }

      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(`top-level type is "${expectedType}"`),
      );
      expect(args).not.toHaveProperty("jsonSchema");
      expect(args?.tools !== undefined).toBe(withTools);
      warn.mockRestore();
    },
  );

  it("continues a logger-disabled streamed tool run without server runContext", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    let streamNumber = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        calls.push({ url, body });

        if (url.includes("/prepareStream")) {
          return new Response(JSON.stringify({ streamId: `s${++streamNumber}` }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("streamId=s1")) {
          return new Response(
            sseDone({
              text: "",
              content: [
                {
                  type: "tool-call",
                  toolCallId: "call_stream",
                  toolName: "getWeather",
                  input: '{"city":"Seoul"}',
                },
              ],
              finishReason: "tool-calls",
              model: "gpt-5.5",
              usage,
              durationMs: 100,
              costUsd: 0.01,
            }),
            { status: 200 },
          );
        }
        return new Response(
          sseDone({
            text: "done",
            content: [{ type: "text", text: "done" }],
            finishReason: "stop",
            model: "gpt-5.5",
            usage,
            durationMs: 80,
            costUsd: 0.005,
          }),
          { status: 200 },
        );
      }),
    );

    const model = qgrid("openai/gpt-5.5");
    const first = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "weather" }] }],
      tools: [tool()],
      providerOptions: { qgrid: { logger: false } },
    } as never);
    for await (const _part of first.stream) {
      // drain so the done event records the pending client tool call
    }

    const second = await model.doStream({
      prompt: toolPrompt(["call_stream"]),
      tools: [tool()],
      providerOptions: { qgrid: { logger: false } },
    } as never);
    for await (const _part of second.stream) {
      // drain
    }

    const prepares = calls.filter((call) => call.url.includes("/prepareStream"));
    expect(prepares).toHaveLength(2);
    expect(prepares[1]?.body.args).toMatchObject({
      logger: false,
      toolResults: [{ toolCallId: "call_stream" }],
    });
    expect(prepares[1]?.body.args).not.toHaveProperty("runContext");
  });

  it("does not store or replay qgrid sessionKey threadCoord for Anthropic models", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        calls.push({ url, body });

        if (url.includes("/prepareStream")) {
          return new Response(JSON.stringify({ streamId: `s${calls.length}` }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          sseDone({
            text: "ok",
            content: [{ type: "text", text: "ok" }],
            finishReason: "stop",
            model: "claude-opus-4-8",
            tokenName: "anthropic/yds",
            usage,
            durationMs: 50,
            costUsd: 0,
            runContext: {
              threadCoord: { threadId: "anthropic-thread", workerId: 1, epoch: 0 },
            },
          }),
          { status: 200 },
        );
      }),
    );

    const model = qgrid("anthropic/claude-opus-4-8");
    const providerOptions = { qgrid: { sessionKey: "anthropic-session" } };

    for (const text of ["first", "second"]) {
      const result = await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text }] }],
        providerOptions,
      } as never);
      const reader = result.stream.getReader();
      expect(await reader.read()).toMatchObject({ done: false, value: { type: "text-start" } });
      expect(await reader.read()).toMatchObject({ done: false, value: { type: "text-delta" } });
      expect(await reader.read()).toMatchObject({ done: false, value: { type: "text-end" } });
      expect(await reader.read()).toMatchObject({
        done: false,
        value: { type: "response-metadata", modelId: "claude-opus-4-8" },
      });
      expect(await reader.read()).toMatchObject({ done: false, value: { type: "finish" } });
      expect(await reader.read()).toEqual({ done: true, value: undefined });
    }

    const prepares = calls.filter((c) => c.url.includes("/prepareStream"));
    expect(prepares).toHaveLength(2);
    expect(prepares[0]?.body.args).not.toHaveProperty("runContext");
    expect(prepares[1]?.body.args).not.toHaveProperty("runContext");
  });

  it("derives the same opaque cache affinity across provider instances without sending sessionKey", async () => {
    const calls: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        calls.push(body.args);
        return new Response(
          JSON.stringify({
            text: "ok",
            model: "gpt-5.5",
            usage,
            durationMs: 10,
            costUsd: 0,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const options = {
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      providerOptions: { qgrid: { sessionKey: "raw-caller-session" } },
    } as never;
    await qgrid("openai/gpt-5.5").doGenerate(options);
    await qgrid("openai/gpt-5.5").doGenerate(options);

    const keys = calls.map((args) => args.cacheAffinityKey);
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(JSON.stringify(calls)).not.toContain("raw-caller-session");
  });

  it("scopes opaque cache affinity by canonical model", async () => {
    const keys: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const args = JSON.parse(String(init?.body)).args;
        keys.push(args.cacheAffinityKey);
        return new Response(
          JSON.stringify({ text: "ok", model: args.model, usage, durationMs: 10, costUsd: 0 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const options = {
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      providerOptions: { qgrid: { sessionKey: "shared" } },
    } as never;
    await qgrid("openai/gpt-5.5").doGenerate(options);
    await qgrid("openai/gpt-5.4").doGenerate(options);

    expect(keys[0]).not.toBe(keys[1]);
  });

  it("does not attach a pending tool run when prompt does not match pending tool calls", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        calls.push({ url, body });

        if (url.includes("/query")) {
          return new Response(
            JSON.stringify({
              text: "",
              content: [
                {
                  type: "tool-call",
                  toolCallId: "call_1",
                  toolName: "getWeather",
                  input: '{"city":"Seoul"}',
                },
              ],
              finishReason: "tool-calls",
              model: "gpt-5.5",
              usage,
              durationMs: 100,
              costUsd: 0.01,
              runContext: { requestLogId: 1 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}", { status: 200 });
      }),
    );

    const model = qgrid("openai/gpt-5.5");
    await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "weather" }] }],
      tools: [tool()],
    } as never);

    // 다른 prompt로 호출 (tool result 없음) → overlap, runContext 안 보냄
    await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "different" }] }],
      tools: [tool()],
    } as never);

    const secondQuery = calls.filter((c) => c.url.includes("/query"))[1];
    expect(secondQuery?.body.args).not.toHaveProperty("runContext");
    expect(secondQuery?.body.args).not.toHaveProperty("logMode");
  });

  it("sends imageGeneration flag and maps image content to a file part", async () => {
    let queryBody: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/query")) {
          queryBody = init?.body ? JSON.parse(String(init.body)) : {};
          return new Response(
            JSON.stringify({
              text: "",
              content: [
                { type: "text", text: "here is your image" },
                { type: "image", data: "iVBORw0KGgoBAgM", revisedPrompt: "a red circle" },
              ],
              finishReason: "stop",
              model: "gpt-5.5",
              usage,
              durationMs: 100,
              costUsd: 0,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}", { status: 200 });
      }),
    );

    const result = await qgrid("openai/gpt-5.5").doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "draw a red circle" }] }],
      providerOptions: { qgrid: { imageGeneration: true } },
    } as never);

    expect((queryBody as { args: Record<string, unknown> }).args).toMatchObject({
      imageGeneration: true,
    });
    // image → LanguageModelV3File 파트로 매핑, tool-call 오인 없음.
    expect(result.content).toEqual([
      { type: "text", text: "here is your image" },
      { type: "file", mediaType: "image/png", data: "iVBORw0KGgoBAgM" },
    ]);
  });

  it("passes imageGenerationOptions through to qgrid", async () => {
    let queryBody: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/query")) {
          queryBody = init?.body ? JSON.parse(String(init.body)) : {};
          return new Response(
            JSON.stringify({
              text: "",
              content: [{ type: "image", data: "iVBORw0KGgoBAgM", revisedPrompt: "a red circle" }],
              finishReason: "stop",
              model: "gpt-5.5",
              usage,
              durationMs: 100,
              costUsd: 0,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}", { status: 200 });
      }),
    );

    await qgrid("openai/gpt-5.5").doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "draw a red circle" }] }],
      providerOptions: {
        qgrid: {
          imageGeneration: true,
          imageGenerationOptions: { quality: "high", size: "1024x1024" },
        },
      },
    } as never);

    expect((queryBody as { args: Record<string, unknown> }).args).toMatchObject({
      imageGeneration: true,
      imageGenerationOptions: { quality: "high", size: "1024x1024" },
    });
  });

  it("sends reference image file parts as qgrid multimodal input", async () => {
    let queryBody: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/query")) {
          queryBody = init?.body ? JSON.parse(String(init.body)) : {};
          return new Response(
            JSON.stringify({
              text: "",
              content: [{ type: "image", data: "iVBORw0KGgoBAgM", revisedPrompt: null }],
              finishReason: "stop",
              model: "gpt-5.5",
              usage,
              durationMs: 100,
              costUsd: 0,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}", { status: 200 });
      }),
    );

    await qgrid("openai/gpt-5.5").doGenerate({
      prompt: [
        {
          role: "user",
          content: [
            { type: "text", text: "use this as a style reference" },
            { type: "file", mediaType: "image/png", data: "iVBORw0KGgoBAgM" },
          ],
        },
      ],
      providerOptions: { qgrid: { imageGeneration: true } },
    } as never);

    expect((queryBody as { args: Record<string, unknown> }).args).toMatchObject({
      prompt: "use this as a style reference",
      input: [
        { type: "text", text: "use this as a style reference", text_elements: [] },
        { type: "image", url: "data:image/png;base64,iVBORw0KGgoBAgM" },
      ],
      imageGeneration: true,
    });
  });

  it("does not send image input for normal non-image-generation calls", async () => {
    let queryBody: unknown;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/query")) {
          queryBody = init?.body ? JSON.parse(String(init.body)) : {};
          return new Response(
            JSON.stringify({
              text: "ok",
              content: [{ type: "text", text: "ok" }],
              finishReason: "stop",
              model: "gpt-5.5",
              usage,
              durationMs: 100,
              costUsd: 0,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}", { status: 200 });
      }),
    );

    await qgrid("openai/gpt-5.5").doGenerate({
      prompt: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe this" },
            { type: "file", mediaType: "image/png", data: "iVBORw0KGgoBAgM" },
          ],
        },
      ],
    } as never);

    expect((queryBody as { args: Record<string, unknown> }).args).toMatchObject({
      prompt: "describe this",
    });
    expect((queryBody as { args: Record<string, unknown> }).args.input).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "[qgrid] 1 image message part(s) were ignored because providerOptions.qgrid.imageGeneration is not enabled.",
    );
  });

  it("does not send history images for normal non-image-generation calls", async () => {
    let queryBody: unknown;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/query")) {
          queryBody = init?.body ? JSON.parse(String(init.body)) : {};
          return new Response(
            JSON.stringify({
              text: "ok",
              content: [{ type: "text", text: "ok" }],
              finishReason: "stop",
              model: "gpt-5.5",
              usage,
              durationMs: 100,
              costUsd: 0,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}", { status: 200 });
      }),
    );

    await qgrid("openai/gpt-5.5").doGenerate({
      prompt: [
        {
          role: "user",
          content: [
            { type: "text", text: "earlier" },
            { type: "file", mediaType: "image/png", data: "iVBORw0KGgoBAgM" },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        { role: "user", content: [{ type: "text", text: "continue" }] },
      ],
    } as never);

    const history = JSON.parse(
      String((queryBody as { args: Record<string, unknown> }).args.history),
    );
    expect(JSON.stringify(history)).not.toContain("input_image");
    expect(warn).toHaveBeenCalledWith(
      "[qgrid] 1 image message part(s) were ignored because providerOptions.qgrid.imageGeneration is not enabled.",
    );
  });

  it("skips non-image file parts for image-generation input", async () => {
    let queryBody: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/query")) {
          queryBody = init?.body ? JSON.parse(String(init.body)) : {};
          return new Response(
            JSON.stringify({
              text: "",
              content: [{ type: "image", data: "iVBORw0KGgoBAgM", revisedPrompt: null }],
              finishReason: "stop",
              model: "gpt-5.5",
              usage,
              durationMs: 100,
              costUsd: 0,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}", { status: 200 });
      }),
    );

    await qgrid("openai/gpt-5.5").doGenerate({
      prompt: [
        {
          role: "user",
          content: [
            { type: "text", text: "use only image files" },
            { type: "file", mediaType: "application/pdf", data: "JVBERi0xLjQ=" },
          ],
        },
      ],
      providerOptions: { qgrid: { imageGeneration: true } },
    } as never);

    expect((queryBody as { args: Record<string, unknown> }).args.input).toBeUndefined();
  });

  it("preserves uppercase URL schemes instead of wrapping them as base64", async () => {
    let queryBody: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/query")) {
          queryBody = init?.body ? JSON.parse(String(init.body)) : {};
          return new Response(
            JSON.stringify({
              text: "",
              content: [{ type: "image", data: "iVBORw0KGgoBAgM", revisedPrompt: null }],
              finishReason: "stop",
              model: "gpt-5.5",
              usage,
              durationMs: 100,
              costUsd: 0,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}", { status: 200 });
      }),
    );

    await qgrid("openai/gpt-5.5").doGenerate({
      prompt: [
        {
          role: "user",
          content: [
            { type: "text", text: "use this as reference" },
            { type: "file", mediaType: "image/png", data: "HTTPS://example.com/ref.png" },
          ],
        },
      ],
      providerOptions: { qgrid: { imageGeneration: true } },
    } as never);

    expect((queryBody as { args: Record<string, unknown> }).args.input).toEqual([
      { type: "text", text: "use this as reference", text_elements: [] },
      { type: "image", url: "HTTPS://example.com/ref.png" },
    ]);
  });

  it("drops unsupported image URL schemes instead of forwarding them", async () => {
    let queryBody: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/query")) {
          queryBody = init?.body ? JSON.parse(String(init.body)) : {};
          return new Response(
            JSON.stringify({
              text: "",
              content: [{ type: "image", data: "iVBORw0KGgoBAgM", revisedPrompt: null }],
              finishReason: "stop",
              model: "gpt-5.5",
              usage,
              durationMs: 100,
              costUsd: 0,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}", { status: 200 });
      }),
    );

    await qgrid("openai/gpt-5.5").doGenerate({
      prompt: [
        {
          role: "user",
          content: [
            { type: "text", text: "use this as reference" },
            { type: "file", mediaType: "image/png", data: "file:///etc/passwd" },
          ],
        },
      ],
      providerOptions: { qgrid: { imageGeneration: true } },
    } as never);

    expect((queryBody as { args: Record<string, unknown> }).args.input).toBeUndefined();
  });

  it("rejects oversized reference image inputs before sending the request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(
      qgrid("openai/gpt-5.5").doGenerate({
        prompt: [
          {
            role: "user",
            content: [
              { type: "text", text: "use this as a style reference" },
              { type: "file", mediaType: "image/png", data: "a".repeat(9_000_001) },
            ],
          },
        ],
        providerOptions: { qgrid: { imageGeneration: true } },
      } as never),
    ).rejects.toThrow(/image input is too large.*WebP\/JPEG/i);

    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects oversized history reference image inputs before sending the request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(
      qgrid("openai/gpt-5.5").doGenerate({
        prompt: [
          {
            role: "user",
            content: [
              { type: "text", text: "earlier" },
              { type: "file", mediaType: "image/png", data: "a".repeat(9_000_001) },
            ],
          },
          { role: "assistant", content: [{ type: "text", text: "ok" }] },
          { role: "user", content: [{ type: "text", text: "continue" }] },
        ],
        providerOptions: { qgrid: { imageGeneration: true } },
      } as never),
    ).rejects.toThrow(/image input is too large.*WebP\/JPEG/i);

    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects image inputs whose combined data-url size is too large", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(
      qgrid("openai/gpt-5.5").doGenerate({
        prompt: [
          {
            role: "user",
            content: [
              { type: "text", text: "use these as references" },
              { type: "file", mediaType: "image/png", data: "a".repeat(4_600_000) },
              { type: "file", mediaType: "image/png", data: "b".repeat(4_600_000) },
            ],
          },
        ],
        providerOptions: { qgrid: { imageGeneration: true } },
      } as never),
    ).rejects.toThrow(/image inputs are too large.*total/i);

    expect(fetch).not.toHaveBeenCalled();
  });

  it("throws when imageGeneration is requested but the response has no image (version skew guard)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/query")) {
          // 구버전 서버: imageGeneration 을 strip 하고 텍스트만 반환.
          return new Response(
            JSON.stringify({
              text: "plain text",
              content: [{ type: "text", text: "plain text" }],
              finishReason: "stop",
              model: "gpt-5.5",
              usage,
              durationMs: 10,
              costUsd: 0,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}", { status: 200 });
      }),
    );

    await expect(
      qgrid("openai/gpt-5.5").doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "draw a red circle" }] }],
        providerOptions: { qgrid: { imageGeneration: true } },
      } as never),
    ).rejects.toThrow(/no image/i);
  });

  it("rejects imageGeneration on the streaming path", async () => {
    await expect(
      qgrid("openai/gpt-5.5").doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "draw a red circle" }] }],
        providerOptions: { qgrid: { imageGeneration: true } },
      } as never),
    ).rejects.toThrow(/not supported with streamText/i);
  });

  // ── SON-527: 툴 사용 시 봉투 증분 파싱으로 answer 델타 재방출 ──
  describe("envelope answer delta re-emission with tools", () => {
    function stubStreamFetch(deltas: string[], done: unknown) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url.includes("/prepareStream")) {
            return new Response(JSON.stringify({ streamId: "s-envelope" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          if (url.includes("/queryStream")) {
            const encoder = new TextEncoder();
            return new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  for (const text of deltas) {
                    controller.enqueue(
                      encoder.encode(`event: delta\ndata: ${JSON.stringify({ text })}\n\n`),
                    );
                  }
                  controller.enqueue(
                    encoder.encode(`event: done\ndata: ${JSON.stringify(done)}\n\n`),
                  );
                  controller.close();
                },
              }),
              { status: 200 },
            );
          }
          return new Response("{}", { status: 200 });
        }),
      );
    }

    async function collectParts(options: Record<string, unknown>) {
      const result = await qgrid("openai/gpt-5.5").doStream(options as never);
      const parts: Array<Record<string, unknown>> = [];
      for await (const part of result.stream) {
        parts.push(part as Record<string, unknown>);
      }
      return parts;
    }

    it("re-emits answer text deltas before done and skips the done full-text fallback", async () => {
      const answer = "일본 여행이라면 도현 #1333 추천해요";
      const envelope = `{"result":{"action":"answer","answer":${JSON.stringify(answer)},"toolCalls":null}}`;
      // 이스케이프/키 경계가 잘리도록 어색한 지점에서 자른 델타
      const deltas = [
        envelope.slice(0, 18),
        envelope.slice(18, 29),
        envelope.slice(29, 47),
        envelope.slice(47),
      ];
      stubStreamFetch(deltas, {
        text: answer,
        content: [{ type: "text", text: answer }],
        finishReason: "stop",
        model: "gpt-5.5",
        usage,
        durationMs: 100,
        costUsd: 0.01,
      });

      const parts = await collectParts({
        prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        tools: [tool()],
      });

      const textDeltas = parts.filter((p) => p.type === "text-delta");
      expect(textDeltas.length).toBeGreaterThan(1); // done 이전 증분 방출
      expect(textDeltas.map((p) => p.delta).join("")).toBe(answer); // 중복 없이 정확히 1회
      expect(parts.filter((p) => p.type === "text-start")).toHaveLength(1);
      expect(parts.at(-1)).toMatchObject({ type: "finish" });
    });

    it("stays silent on tool_call envelopes and still maps tool-call content", async () => {
      const envelope =
        '{"result":{"action":"tool_call","answer":null,"toolCalls":[{"toolName":"getWeather","args":"{\\"city\\":\\"tokyo\\"}"}]}}';
      stubStreamFetch([envelope.slice(0, 40), envelope.slice(40)], {
        text: "",
        content: [
          { type: "tool-call", toolCallId: "qg_1", toolName: "getWeather", input: '{"city":"tokyo"}' },
        ],
        finishReason: "tool-calls",
        model: "gpt-5.5",
        usage,
        durationMs: 100,
        costUsd: 0.01,
      });

      const parts = await collectParts({
        prompt: [{ role: "user", content: [{ type: "text", text: "weather" }] }],
        tools: [tool()],
      });

      expect(parts.filter((p) => p.type === "text-delta")).toHaveLength(0);
      expect(parts.filter((p) => p.type === "tool-call")).toHaveLength(1);
      expect(parts.at(-1)).toMatchObject({
        type: "finish",
        finishReason: { unified: "tool-calls" },
      });
    });

    it("re-emits raw answer JSON deltas when tools and a user schema are combined", async () => {
      const answerObj = { result: "일본 여행 특집" };
      const rawAnswer = JSON.stringify(answerObj);
      const envelope = `{"result":{"action":"answer","answer":${rawAnswer},"toolCalls":null}}`;
      stubStreamFetch(
        [envelope.slice(0, 45), envelope.slice(45, 52), envelope.slice(52)],
        {
          text: rawAnswer,
          content: [{ type: "text", text: rawAnswer }],
          finishReason: "stop",
          model: "gpt-5.5",
          usage,
          durationMs: 100,
          costUsd: 0.01,
        },
      );

      const parts = await collectParts({
        prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        tools: [tool()],
        responseFormat: { type: "json", schema: structuredOutputSchema },
      });

      const textDeltas = parts.filter((p) => p.type === "text-delta");
      expect(textDeltas.length).toBeGreaterThan(1);
      const streamed = textDeltas.map((p) => p.delta).join("");
      expect(streamed).toBe(rawAnswer); // raw JSON verbatim → partialOutputStream 부분 파싱 가능
      expect(JSON.parse(streamed)).toEqual(answerObj);
    });

    it("falls back to the done full-text emission when no deltas arrive", async () => {
      const answer = "델타 없는 완성본";
      stubStreamFetch([], {
        text: answer,
        content: [{ type: "text", text: answer }],
        finishReason: "stop",
        model: "gpt-5.5",
        usage,
        durationMs: 100,
        costUsd: 0.01,
      });

      const parts = await collectParts({
        prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        tools: [tool()],
      });

      const textDeltas = parts.filter((p) => p.type === "text-delta");
      expect(textDeltas.map((p) => p.delta).join("")).toBe(answer);
    });

    it("falls back cleanly when a text preamble precedes the envelope (parser silent)", async () => {
      const answer = "폴백 답변";
      const envelope = `{"result":{"action":"answer","answer":${JSON.stringify(answer)},"toolCalls":null}}`;
      stubStreamFetch(["생각해 볼게요. ", envelope], {
        text: answer,
        content: [{ type: "text", text: answer }],
        finishReason: "stop",
        model: "gpt-5.5",
        usage,
        durationMs: 100,
        costUsd: 0.01,
      });

      const parts = await collectParts({
        prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        tools: [tool()],
      });

      // 프리앰블 원문이 절대 새어나가면 안 되고, done 폴백이 정확히 1회 방출한다.
      const textDeltas = parts.filter((p) => p.type === "text-delta");
      expect(textDeltas.map((p) => p.delta).join("")).toBe(answer);
      expect(textDeltas.some((p) => String(p.delta).includes("생각해"))).toBe(false);
    });

    it("skips empty-string deltas without emitting empty text parts", async () => {
      const answer = "ok";
      const envelope = `{"result":{"action":"answer","answer":"ok","toolCalls":null}}`;
      stubStreamFetch(["", envelope.slice(0, 30), "", envelope.slice(30), ""], {
        text: answer,
        content: [{ type: "text", text: answer }],
        finishReason: "stop",
        model: "gpt-5.5",
        usage,
        durationMs: 100,
        costUsd: 0.01,
      });

      const parts = await collectParts({
        prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        tools: [tool()],
      });

      const textDeltas = parts.filter((p) => p.type === "text-delta");
      expect(textDeltas.every((p) => p.delta !== "")).toBe(true);
      expect(textDeltas.map((p) => p.delta).join("")).toBe(answer);
    });

    it("keeps the no-tools delta path verbatim, even for envelope-looking text", async () => {
      // 툴 없는 호출은 봉투가 없으므로 파서를 태우면 안 된다 — 원문 그대로.
      const fakeEnvelopeText = '{"result":{"action":"answer","answer":"이건 그냥 본문"}}';
      stubStreamFetch([fakeEnvelopeText.slice(0, 20), fakeEnvelopeText.slice(20)], {
        text: fakeEnvelopeText,
        content: [{ type: "text", text: fakeEnvelopeText }],
        finishReason: "stop",
        model: "gpt-5.5",
        usage,
        durationMs: 100,
        costUsd: 0.01,
      });

      const parts = await collectParts({
        prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      });

      const textDeltas = parts.filter((p) => p.type === "text-delta");
      expect(textDeltas.map((p) => p.delta).join("")).toBe(fakeEnvelopeText);
    });

    it("runs a full streamed tool loop: silent tool_call turn, then streamed answer follow-up", async () => {
      const toolEnvelope =
        '{"result":{"action":"tool_call","answer":null,"toolCalls":[{"toolName":"getWeather","args":"{\\"city\\":\\"Seoul\\"}"}]}}';
      const answer = "서울은 맑아요";
      const answerEnvelope = `{"result":{"action":"answer","answer":${JSON.stringify(answer)},"toolCalls":null}}`;
      const encoder = new TextEncoder();
      let streamNumber = 0;

      const sseFrom = (deltas: string[], done: unknown) =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const text of deltas) {
              controller.enqueue(
                encoder.encode(`event: delta\ndata: ${JSON.stringify({ text })}\n\n`),
              );
            }
            controller.enqueue(encoder.encode(`event: done\ndata: ${JSON.stringify(done)}\n\n`));
            controller.close();
          },
        });

      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url.includes("/prepareStream")) {
            return new Response(JSON.stringify({ streamId: `s${++streamNumber}` }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          if (url.includes("streamId=s1")) {
            return new Response(
              sseFrom([toolEnvelope.slice(0, 33), toolEnvelope.slice(33)], {
                text: "",
                content: [
                  {
                    type: "tool-call",
                    toolCallId: "call_loop",
                    toolName: "getWeather",
                    input: '{"city":"Seoul"}',
                  },
                ],
                finishReason: "tool-calls",
                model: "gpt-5.5",
                usage,
                durationMs: 100,
                costUsd: 0.01,
              }),
              { status: 200 },
            );
          }
          return new Response(
            sseFrom([answerEnvelope.slice(0, 41), answerEnvelope.slice(41)], {
              text: answer,
              content: [{ type: "text", text: answer }],
              finishReason: "stop",
              model: "gpt-5.5",
              usage,
              durationMs: 80,
              costUsd: 0.005,
            }),
            { status: 200 },
          );
        }),
      );

      const model = qgrid("openai/gpt-5.5");
      const first = await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "weather" }] }],
        tools: [tool()],
      } as never);
      const firstParts: Array<Record<string, unknown>> = [];
      for await (const part of first.stream) firstParts.push(part as Record<string, unknown>);

      // 1턴: tool_call — 봉투 델타가 텍스트로 새면 안 된다.
      expect(firstParts.filter((p) => p.type === "text-delta")).toHaveLength(0);
      expect(firstParts.filter((p) => p.type === "tool-call")).toHaveLength(1);

      const second = await model.doStream({
        prompt: toolPrompt(["call_loop"]),
        tools: [tool()],
      } as never);
      const secondParts: Array<Record<string, unknown>> = [];
      for await (const part of second.stream) secondParts.push(part as Record<string, unknown>);

      // 2턴: 새 파서 인스턴스로 answer 증분 방출.
      const textDeltas = secondParts.filter((p) => p.type === "text-delta");
      expect(textDeltas.length).toBeGreaterThan(1);
      expect(textDeltas.map((p) => p.delta).join("")).toBe(answer);
    });
  });
});
