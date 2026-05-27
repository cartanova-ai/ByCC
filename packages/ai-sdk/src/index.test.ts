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
  it("sends tools and maps tool-call response", async () => {
    let queryBody: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
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
        const body = JSON.parse(String(init?.body));
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

  it("sends logMode:'run' for all doStream calls", async () => {
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
    expect(prepareCall?.body.args).toMatchObject({ logMode: "run" });

    // SDK는 직접 lifecycle 호출 안 함
    expect(calls.filter((c) => c.url.includes("/createRun"))).toHaveLength(0);
    expect(calls.filter((c) => c.url.includes("/finishRun"))).toHaveLength(0);
  });

  it("clears client run state when prompt does not match pending tool calls", async () => {
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
});
