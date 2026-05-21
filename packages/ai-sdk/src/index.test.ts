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
});
