import { afterEach, describe, expect, it, vi } from "vitest";

import { qgrid } from "./index";

const usage = {
  input_tokens: 10,
  output_tokens: 5,
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
      },
    });
    expect((queryBody as { args: Record<string, unknown> }).args).not.toHaveProperty(
      "fallbackModels",
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
        logMode: "run",
        tools: [{ name: "getWeather", description: "Get weather" }],
      },
    });
    expect(result.finishReason).toEqual({ unified: "tool-calls", raw: "tool_call" });
    expect(result.content).toEqual([
      {
        type: "tool-call",
        toolCallId: "call_weather",
        toolName: "getWeather",
        input: JSON.stringify({ city: "Seoul" }),
      },
    ]);
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
              text: "Seoul is 22°C",
              content: [{ type: "text", text: "Seoul is 22°C" }],
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
    } as never);

    // 턴 2: follow-up with tool result
    const result = await model.doGenerate({
      prompt: toolPrompt(["call_1"]),
      tools: [tool()],
    } as never);

    // follow-up 호출에 runContext + toolResults가 포함되어야 함
    const followUpQuery = calls.filter((c) => c.url.includes("/query"))[1];
    expect(followUpQuery?.body.args).toMatchObject({
      logMode: "run",
      runContext: { requestLogId: 42 },
      toolResults: [{ toolCallId: "call_1" }],
    });

    // SDK는 직접 createRun/appendStep/finishRun 호출 안 함
    expect(calls.filter((c) => c.url.includes("/createRun"))).toHaveLength(0);
    expect(calls.filter((c) => c.url.includes("/appendStep"))).toHaveLength(0);
    expect(calls.filter((c) => c.url.includes("/finishRun"))).toHaveLength(0);

    expect(result.content).toEqual([{ type: "text", text: "Seoul is 22°C" }]);
  });

  it("keeps parallel tool-call runs isolated on one model instance", async () => {
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
              runContext: { requestLogId: suffix === "a" ? 101 : 102 },
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
      } as never),
      model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "weather b" }] }],
        tools: [tool()],
      } as never),
    ]);

    await model.doGenerate({
      prompt: toolPrompt(["call_a"]),
      tools: [tool()],
    } as never);
    await model.doGenerate({
      prompt: toolPrompt(["call_b"]),
      tools: [tool()],
    } as never);

    const queryBodies = calls.filter((c) => c.url.includes("/query")).map((c) => c.body);
    const followUpA = queryBodies.find((body) =>
      JSON.stringify(body.args.toolResults ?? []).includes("call_a"),
    );
    const followUpB = queryBodies.find((body) =>
      JSON.stringify(body.args.toolResults ?? []).includes("call_b"),
    );

    expect(followUpA?.args).toMatchObject({
      runContext: { requestLogId: 101 },
      toolResults: [{ toolCallId: "call_a" }],
    });
    expect(followUpB?.args).toMatchObject({
      runContext: { requestLogId: 102 },
      toolResults: [{ toolCallId: "call_b" }],
    });
  });

  it("does not send logMode for non-tool doGenerate", async () => {
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

    // logMode가 없어야 함 (서버 auto 경로)
    expect((queryBody as Record<string, unknown>).args).not.toHaveProperty("logMode");
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

  it("does not send logMode for non-tool doStream (server treats as auto)", async () => {
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
    } as never);
    for await (const _part of result.stream) {
      // drain
    }

    const prepareCall = calls.find((c) => c.url.includes("/prepareStream"));
    // tool이 없으면 logMode를 보내지 않는다 → 서버가 auto로 처리(step 없이 request_log 1건).
    expect(prepareCall?.body.args).not.toHaveProperty("logMode");

    // SDK는 직접 lifecycle 호출 안 함
    expect(calls.filter((c) => c.url.includes("/createRun"))).toHaveLength(0);
    expect(calls.filter((c) => c.url.includes("/finishRun"))).toHaveLength(0);
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
      expect(await reader.read()).toMatchObject({ done: false, value: { type: "finish" } });
      expect(await reader.read()).toEqual({ done: true, value: undefined });
    }

    const prepares = calls.filter((c) => c.url.includes("/prepareStream"));
    expect(prepares).toHaveLength(2);
    expect(prepares[0]?.body.args).not.toHaveProperty("runContext");
    expect(prepares[1]?.body.args).not.toHaveProperty("runContext");
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
    expect(secondQuery?.body.args).toMatchObject({ logMode: "run" });
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
});
