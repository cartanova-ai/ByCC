import { describe, expect, it } from "vitest";

import { normalizeOpenAISSE, parseOpenAISSE } from "./openai-sse";

function chunks(...values: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const value of values) controller.enqueue(encoder.encode(value));
      controller.close();
    },
  });
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of iterable) result.push(value);
  return result;
}

describe("OpenAI SSE parser", () => {
  it("handles split UTF-8, CRLF, comments, and multiline data", async () => {
    const source = ': ping\r\ndata: {"type":"response.output_text.delta"\r\ndata: ,"delta":"hé"}\r\n\r\n';
    const bytes = new TextEncoder().encode(source);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    expect(await collect(parseOpenAISSE(stream))).toEqual([
      { type: "response.output_text.delta", delta: "hé" },
    ]);
  });

  it("normalizes deltas and requires response.completed before DONE", async () => {
    const body = chunks(
      'data: {"type":"response.output_text.delta","delta":"hello"}\n\n',
      'data: {"type":"response.completed","response":{"id":"r1"}}\n\ndata: [DONE]\n\n',
    );
    expect(await collect(normalizeOpenAISSE(body))).toEqual([
      { type: "text-delta", text: "hello" },
      { type: "completed", responseId: "r1" },
    ]);
  });

  it("rejects truncated streams", async () => {
    await expect(
      collect(normalizeOpenAISSE(chunks('data: {"type":"response.created"}\n\n'))),
    ).rejects.toThrow("closed before a terminal event");
  });
});
