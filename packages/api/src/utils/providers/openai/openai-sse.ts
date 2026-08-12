import {
  normalizeOpenAIEvent,
  OpenAIProtocolError,
  type OpenAINormalizedEvent,
} from "./openai-backend-protocol";

export interface OpenAIEventStream extends AsyncIterable<OpenAINormalizedEvent> {}

function parseBlock(block: string): unknown | undefined {
  const data: string[] = [];
  for (const line of block.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")) {
    if (line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
  }
  if (!data.length) return undefined;
  const payload = data.join("\n");
  if (payload === "[DONE]") return payload;
  try {
    return JSON.parse(payload) as unknown;
  } catch (error) {
    throw new OpenAIProtocolError(`Invalid OpenAI SSE JSON: ${String(error)}`);
  }
}

/** Parses arbitrary UTF-8/chunk boundaries and all complete SSE event blocks. */
export async function* parseOpenAISSE(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let match: RegExpExecArray | null;
      while ((match = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const parsed = parseBlock(block);
        if (parsed !== undefined) yield parsed;
      }
      if (done) break;
    }
    if (buffer.trim()) {
      const parsed = parseBlock(buffer);
      if (parsed !== undefined) yield parsed;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Converts wire events and enforces exactly one successful terminal response. */
export async function* normalizeOpenAISSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<OpenAINormalizedEvent> {
  let terminal = false;
  for await (const raw of parseOpenAISSE(body)) {
    if (raw === "[DONE]") {
      if (!terminal) throw new OpenAIProtocolError("OpenAI stream ended before response.completed");
      return;
    }
    if (terminal) throw new OpenAIProtocolError("OpenAI stream emitted an event after termination");
    const event = normalizeOpenAIEvent(raw);
    if (!event) continue;
    if (event.type === "error") {
      terminal = true;
      yield event;
      return;
    }
    if (event.type === "completed") terminal = true;
    yield event;
  }
  if (!terminal)
    throw new OpenAIProtocolError("OpenAI SSE connection closed before a terminal event");
}
