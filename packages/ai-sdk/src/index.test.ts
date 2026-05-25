import { afterEach, describe, expect, it, vi } from "vitest";

import { qgrid } from "./index";

const usage = {
  input_tokens: 10,
  output_tokens: 5,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 3,
};

afterEach(() => {
  vi.useRealTimers();
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
  it("passes tools to qgrid server and maps qgrid-native tool calls", async () => {
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
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ requestLogId: 1, stepId: 1, ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const result = await qgrid("openai/gpt-5.5").doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "weather" }] }],
      tools: [
        {
          type: "function",
          name: "getWeather",
          description: "Get weather",
          inputSchema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      ],
    } as never);

    expect(queryBody).toMatchObject({
      args: {
        prompt: "weather",
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

  it("finalizes previous run as error when sequential overlap arrives on same instance", async () => {
    const calls: Array<{
      url: string;
      body: { input?: Record<string, unknown>; args?: Record<string, unknown> };
    }> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        calls.push({ url, body });

        if (url.includes("/createRun")) {
          return new Response(JSON.stringify({ requestLogId: 1 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        if (url.includes("/query")) {
          return new Response(
            JSON.stringify({
              text: "",
              content: [
                {
                  type: "tool-call",
                  toolCallId: "call_1",
                  toolName: "getWeather",
                  input: JSON.stringify({ city: "Seoul" }),
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

        return new Response(JSON.stringify({ stepId: 1, ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const model = qgrid("openai/gpt-5.5");
    // first: tool-calls로 끝나므로 runState가 살아 있음
    await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "first" }] }],
      tools: [tool()],
    } as never);

    // second: follow-up이 아닌 새 호출 → runState !== null && !match → overlap
    await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "second" }] }],
      tools: [tool()],
    } as never);

    const finishRuns = calls.filter((c) => c.url.includes("/finishRun"));
    expect(finishRuns).toHaveLength(1);
    expect(finishRuns[0].body.input).toMatchObject({
      status: "error",
      errorMessage: expect.stringContaining("overlapping"),
    });
  });

  it("logs only newly completed tool calls and stores final prompt history", async () => {
    const calls: Array<{
      url: string;
      body: { input?: Record<string, unknown>; args?: Record<string, unknown> };
    }> = [];
    let queryCount = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        calls.push({ url, body });

        if (url.includes("/createRun")) {
          return new Response(JSON.stringify({ requestLogId: 1 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        if (url.includes("/query")) {
          queryCount += 1;
          const content =
            queryCount === 1
              ? [
                  {
                    type: "tool-call",
                    toolCallId: "call_1",
                    toolName: "getWeather",
                    input: JSON.stringify({ city: "Seoul" }),
                  },
                ]
              : queryCount === 2
                ? [
                    {
                      type: "tool-call",
                      toolCallId: "call_2",
                      toolName: "getWeather",
                      input: JSON.stringify({ city: "Busan" }),
                    },
                  ]
                : [{ type: "text", text: "done" }];
          return new Response(
            JSON.stringify({
              text: queryCount === 3 ? "done" : "",
              content,
              finishReason: queryCount === 3 ? "stop" : "tool-calls",
              model: "gpt-5.5",
              usage,
              durationMs: 100,
              costUsd: 0.01,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        return new Response(JSON.stringify({ stepId: 1, ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const model = qgrid("openai/gpt-5.5");
    await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "weather" }] }],
      tools: [tool()],
    } as never);
    await model.doGenerate({ prompt: toolPrompt(["call_1"]), tools: [tool()] } as never);
    await model.doGenerate({ prompt: toolPrompt(["call_1", "call_2"]), tools: [tool()] } as never);

    const toolCallIds = calls
      .filter((c) => c.url.includes("/appendStep") && c.body.input?.type === "tool_call")
      .map((c) => c.body.input?.toolCallId);
    expect(toolCallIds).toEqual(["call_1", "call_2"]);

    const finishRun = calls.find((c) => c.url.includes("/finishRun"));
    expect(JSON.parse(String(finishRun?.body.input?.history))).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "weather" }] },
    ]);
  });

  it("finalizes a tool-call run when no follow-up step arrives before the stale timeout", async () => {
    vi.useFakeTimers();
    const calls: Array<{
      url: string;
      body: { input?: Record<string, unknown>; args?: Record<string, unknown> };
    }> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        calls.push({ url, body });

        if (url.includes("/createRun")) {
          return new Response(JSON.stringify({ requestLogId: 1 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        if (url.includes("/query")) {
          return new Response(
            JSON.stringify({
              text: "",
              content: [
                {
                  type: "tool-call",
                  toolCallId: "call_1",
                  toolName: "getWeather",
                  input: JSON.stringify({ city: "Seoul" }),
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

        return new Response(JSON.stringify({ stepId: 1, ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    await qgrid("openai/gpt-5.5").doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "weather" }] }],
      tools: [tool()],
    } as never);

    // hardcoded 30분 timer
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);

    const finishRun = calls.find((c) => c.url.includes("/finishRun"));
    expect(finishRun?.body.input).toMatchObject({
      requestLogId: 1,
      status: "error",
      errorMessage: expect.stringContaining("no follow-up"),
    });
  });

  it("logs non-tool streams through the wrapper lifecycle", async () => {
    const calls: Array<{
      url: string;
      body: { input?: Record<string, unknown>; args?: Record<string, unknown> };
    }> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        calls.push({ url, body });

        if (url.includes("/createRun")) {
          return new Response(JSON.stringify({ requestLogId: 1 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("/prepareStream")) {
          return new Response(JSON.stringify({ streamId: "stream-1" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("/queryStream")) {
          return new Response(
            sseDone({
              text: "stream done",
              content: [{ type: "text", text: "stream done" }],
              finishReason: "stop",
              model: "gpt-5.5",
              usage,
              durationMs: 100,
              costUsd: 0.01,
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ stepId: 1, ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const result = await qgrid("openai/gpt-5.5").doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    } as never);
    for await (const _part of result.stream) {
      // drain stream
    }

    const createRun = calls.find((c) => c.url.includes("/createRun"));
    expect(createRun?.body.input).toMatchObject({ userPrompt: "hello" });

    const finishRun = calls.find((c) => c.url.includes("/finishRun"));
    expect(finishRun?.body.input).toMatchObject({
      requestLogId: 1,
      status: "succeeded",
      response: "stream done",
    });
  });
});
