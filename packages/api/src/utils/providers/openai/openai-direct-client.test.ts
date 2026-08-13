import { describe, expect, it, vi } from "vitest";

import { CHATGPT_CODEX_RESPONSES_URL } from "./openai-backend-protocol";
import {
  OpenAIDirectClient,
  type OpenAIWebSocketFactory,
  type OpenAIWebSocketLike,
} from "./openai-direct-client";

function sse(...events: object[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")),
        );
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

describe("OpenAI direct HTTPS client", () => {
  it("posts the pinned body and Codex identity without live calls", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      sse(
        { type: "response.output_text.delta", delta: "ok" },
        { type: "response.completed", response: { id: "r1" } },
      ),
    );
    const client = new OpenAIDirectClient({
      credentials: { accessToken: "access", accountId: "acct" },
      fetch: fetchMock,
    });

    expect(await collect(client.responses({ model: "gpt-test", history: [{ type: "message" }] }))).toEqual([
      { type: "text-delta", text: "ok" },
      { type: "completed", responseId: "r1" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(CHATGPT_CODEX_RESPONSES_URL);
    expect(init).toMatchObject({ method: "POST" });
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer access",
      "ChatGPT-Account-ID": "acct",
      originator: "codex_cli_rs",
      "x-client-request-id": expect.any(String),
    });
    expect(init?.headers).not.toHaveProperty("OpenAI-Beta");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "gpt-test",
      input: [{ type: "message" }],
      store: false,
      stream: true,
    });
  });

  it("refreshes once after 401 and uses replacement credentials", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{"error":{"message":"expired"}}', { status: 401 }))
      .mockResolvedValueOnce(sse({ type: "response.completed", response: { id: "r2" } }));
    const refresh = vi.fn(async () => ({ accessToken: "new", accountId: "acct2" }));
    const client = new OpenAIDirectClient({
      credentials: { accessToken: "old", accountId: "acct1" },
      fetch: fetchMock,
      refreshCredentials: refresh,
    });

    await collect(client.responses({ model: "gpt-test", history: [] }));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer new",
      "ChatGPT-Account-ID": "acct2",
    });
    const firstHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    const secondHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(secondHeaders["session-id"]).toBe(firstHeaders["session-id"]);
    expect(secondHeaders["thread-id"]).toBe(firstHeaders["thread-id"]);
    expect(secondHeaders["x-client-request-id"]).toBe(firstHeaders["x-client-request-id"]);
  });

  it("never replays a POST after a rejected or ambiguous attempt", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('{"error":{"message":"busy","code":"rate_limit"}}', {
          status: 429,
          headers: { "retry-after": "0" },
        }),
      )
      .mockResolvedValueOnce(sse({ type: "response.completed", response: { id: "never" } }));
    const client = new OpenAIDirectClient({
      credentials: { accessToken: "access", accountId: "acct" },
      fetch: fetchMock,
    });

    await expect(
      collect(client.responses({ model: "gpt-test", history: [] })),
    ).rejects.toThrow("busy");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("passes abort to fetch and does not retry an aborted request", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      await new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))),
      );
      throw new Error("unreachable");
    });
    const controller = new AbortController();
    const client = new OpenAIDirectClient({
      credentials: { accessToken: "access", accountId: "acct" },
      fetch: fetchMock,
    });
    const result = collect(client.responses({ model: "gpt-test", history: [] }, controller.signal));
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses opaque prompt affinity as stable session and thread ids with unique request ids", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      sse({ type: "response.completed", response: { id: "r" } }),
    );
    const client = new OpenAIDirectClient({
      credentials: { accessToken: "access", accountId: "acct" },
      fetch: fetchMock,
    });
    await collect(client.responses({ model: "gpt-test", history: [], promptCacheKey: "opaque" }));
    await collect(client.responses({ model: "gpt-test", history: [], promptCacheKey: "opaque" }));
    const firstHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    const secondHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(firstHeaders).toMatchObject({
      "session-id": expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      "thread-id": expect.any(String),
    });
    expect(firstHeaders["thread-id"]).toBe(firstHeaders["session-id"]);
    expect(secondHeaders["session-id"]).toBe(firstHeaders["session-id"]);
    expect(secondHeaders["thread-id"]).toBe(firstHeaders["thread-id"]);
    expect(secondHeaders["x-client-request-id"]).not.toBe(firstHeaders["x-client-request-id"]);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      prompt_cache_key: firstHeaders["session-id"],
    });
  });
});

type Listener = (...args: never[]) => void;

class MockSocket implements OpenAIWebSocketLike {
  readonly listeners = new Map<string, Listener[]>();
  readonly sent: string[] = [];
  closed?: { code?: number; reason?: string };
  terminated = false;
  sendError?: Error;

  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  off(event: string, listener: Listener): this {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter((candidate) => candidate !== listener),
    );
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...(args as never[]));
  }

  send(data: string, callback?: (error?: Error) => void): void {
    this.sent.push(data);
    callback?.(this.sendError);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }

  terminate(): void {
    this.terminated = true;
  }
}

function mockedWebSocket() {
  const sockets: MockSocket[] = [];
  const calls: Array<{ url: string; options: { headers?: Record<string, string> } }> = [];
  const factory: OpenAIWebSocketFactory = (url, options) => {
    const socket = new MockSocket();
    sockets.push(socket);
    calls.push({ url, options: options as { headers?: Record<string, string> } });
    return socket;
  };
  return { factory, sockets, calls };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("OpenAI direct Responses WebSocket client", () => {
  it("scheme-swaps the pinned URL, sends identity headers and one response.create body", async () => {
    const mock = mockedWebSocket();
    const client = new OpenAIDirectClient({
      credentials: { accessToken: "access", accountId: "acct" },
      transportKind: "websocket",
      webSocketFactory: mock.factory,
    });
    const result = collect(client.responses({ model: "gpt-test", history: [{ type: "message" }] }));
    mock.sockets[0]!.emit("open");
    await tick();
    mock.sockets[0]!.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "response.output_text.delta", delta: "ok" })),
      false,
    );
    mock.sockets[0]!.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "response.completed", response: { id: "r1" } })),
      false,
    );

    await expect(result).resolves.toEqual([
      { type: "text-delta", text: "ok" },
      { type: "completed", responseId: "r1" },
    ]);
    expect(mock.calls[0]).toMatchObject({
      url: "wss://chatgpt.com/backend-api/codex/responses",
      options: {
        headers: {
          Authorization: "Bearer access",
          "ChatGPT-Account-ID": "acct",
          originator: "codex_cli_rs",
          "OpenAI-Beta": "responses_websockets=2026-02-06",
        },
      },
    });
    const headers = mock.calls[0]!.options.headers!;
    expect(headers["x-client-request-id"]).toBe(headers["thread-id"]);
    expect(JSON.parse(mock.sockets[0]!.sent[0]!)).toMatchObject({
      type: "response.create",
      model: "gpt-test",
      input: [{ type: "message" }],
    });
    expect(mock.sockets[0]!.closed).toEqual({ code: 1000, reason: "response completed" });
    expect(mock.sockets[0]!.terminated).toBe(false);
    expect([...mock.sockets[0]!.listeners.values()].flat()).toHaveLength(0);
  });

  it("reuses one WebSocket for sequential requests with the same prompt affinity", async () => {
    const mock = mockedWebSocket();
    const client = new OpenAIDirectClient({
      credentials: { accessToken: "access", accountId: "acct" },
      transportKind: "websocket",
      webSocketFactory: mock.factory,
    });

    const firstController = new AbortController();
    const first = collect(
      client.responses(
        { model: "gpt", history: [], promptCacheKey: "shared" },
        firstController.signal,
      ),
    );
    mock.sockets[0]!.emit("open");
    await tick();
    mock.sockets[0]!.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "response.completed", response: { id: "r1" } })),
      false,
    );
    await first;
    firstController.abort();

    const second = collect(
      client.responses({ model: "gpt", history: [], promptCacheKey: "shared" }),
    );
    await tick();
    mock.sockets[0]!.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "response.completed", response: { id: "r2" } })),
      false,
    );
    await second;

    expect(mock.sockets).toHaveLength(1);
    expect(mock.sockets[0]!.sent).toHaveLength(2);
    expect(mock.sockets[0]!.closed).toBeUndefined();
    expect(mock.sockets[0]!.terminated).toBe(false);
  });

  it("aborts a request that reuses a pooled WebSocket", async () => {
    const mock = mockedWebSocket();
    const client = new OpenAIDirectClient({
      credentials: { accessToken: "access", accountId: "acct" },
      transportKind: "websocket",
      webSocketFactory: mock.factory,
    });
    const first = collect(
      client.responses({ model: "gpt", history: [], promptCacheKey: "shared" }),
    );
    mock.sockets[0]!.emit("open");
    await tick();
    mock.sockets[0]!.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "response.completed", response: { id: "r1" } })),
      false,
    );
    await first;

    const controller = new AbortController();
    const second = collect(
      client.responses(
        { model: "gpt", history: [], promptCacheKey: "shared" },
        controller.signal,
      ),
    );
    await tick();
    controller.abort();

    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(mock.sockets[0]!.terminated).toBe(true);
  });

  it("fails binary frames and closes without a terminal event without replay", async () => {
    const mock = mockedWebSocket();
    const client = new OpenAIDirectClient({
      credentials: { accessToken: "access", accountId: "acct" },
      transportKind: "websocket",
      webSocketFactory: mock.factory,
    });
    const binary = collect(client.responses({ model: "gpt", history: [] }));
    mock.sockets[0]!.emit("open");
    await tick();
    mock.sockets[0]!.emit("message", Buffer.from([1]), true);
    await expect(binary).rejects.toThrow("unexpected binary message");
    expect(mock.sockets[0]!.terminated).toBe(true);
    expect([...mock.sockets[0]!.listeners.values()].flat()).toHaveLength(0);
    expect(mock.sockets).toHaveLength(1);

    const closed = collect(client.responses({ model: "gpt", history: [] }));
    mock.sockets[1]!.emit("open");
    await tick();
    mock.sockets[1]!.emit("close", 1006, Buffer.from("lost"));
    await expect(closed).rejects.toThrow("closed before a terminal response event");
    expect(mock.sockets[1]!.terminated).toBe(true);
    expect(mock.sockets).toHaveLength(2);
  });

  it("terminates and removes listeners for invalid JSON, normalized errors, and send failures", async () => {
    const mock = mockedWebSocket();
    const client = new OpenAIDirectClient({
      credentials: { accessToken: "access", accountId: "acct" },
      transportKind: "websocket",
      webSocketFactory: mock.factory,
    });

    const invalid = collect(client.responses({ model: "gpt", history: [] }));
    mock.sockets[0]!.emit("open");
    await tick();
    mock.sockets[0]!.emit("message", Buffer.from("{"), false);
    await expect(invalid).rejects.toThrow("invalid JSON");

    const normalized = collect(client.responses({ model: "gpt", history: [] }));
    mock.sockets[1]!.emit("open");
    await tick();
    mock.sockets[1]!.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "response.failed", error: { message: "failed" } })),
      false,
    );
    await expect(normalized).rejects.toThrow("failed");

    const sendFailure = collect(client.responses({ model: "gpt", history: [] }));
    mock.sockets[2]!.sendError = new Error("send failed");
    mock.sockets[2]!.emit("open");
    await expect(sendFailure).rejects.toThrow("send failed");

    for (const socket of mock.sockets) {
      expect(socket.terminated).toBe(true);
      expect([...socket.listeners.values()].flat()).toHaveLength(0);
    }
  });

  it("terminates on iterator cancellation and when the receive buffer exceeds 1600 records", async () => {
    const mock = mockedWebSocket();
    const client = new OpenAIDirectClient({
      credentials: { accessToken: "access", accountId: "acct" },
      transportKind: "websocket",
      webSocketFactory: mock.factory,
    });

    const iterator = client.responses({ model: "gpt", history: [] })[Symbol.asyncIterator]();
    const first = iterator.next();
    mock.sockets[0]!.emit("open");
    await tick();
    mock.sockets[0]!.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "response.output_text.delta", delta: "one" })),
      false,
    );
    await expect(first).resolves.toMatchObject({ value: { type: "text-delta", text: "one" } });
    await iterator.return?.();
    expect(mock.sockets[0]!.terminated).toBe(true);
    expect([...mock.sockets[0]!.listeners.values()].flat()).toHaveLength(0);

    const overflow = collect(client.responses({ model: "gpt", history: [] }));
    mock.sockets[1]!.emit("open");
    await tick();
    const ignored = Buffer.from(JSON.stringify({ type: "ignored" }));
    for (let index = 0; index < 1602; index += 1) mock.sockets[1]!.emit("message", ignored, false);
    await expect(overflow).rejects.toMatchObject({ code: "websocket_backpressure" });
    expect(mock.sockets[1]!.terminated).toBe(true);
    expect([...mock.sockets[1]!.listeners.values()].flat()).toHaveLength(0);
  });

  it("closes on abort and refreshes only one definitive 401 handshake rejection", async () => {
    const mock = mockedWebSocket();
    const refresh = vi.fn(async () => ({ accessToken: "new", accountId: "acct2" }));
    const client = new OpenAIDirectClient({
      credentials: { accessToken: "old", accountId: "acct1" },
      transportKind: "websocket",
      webSocketFactory: mock.factory,
      refreshCredentials: refresh,
    });
    const result = collect(client.responses({ model: "gpt", history: [] }));
    mock.sockets[0]!.emit("unexpected-response", {}, { statusCode: 401 });
    await tick();
    expect(mock.sockets[0]!.terminated).toBe(true);
    expect(mock.calls[1]?.options.headers).toMatchObject({ Authorization: "Bearer new" });
    mock.sockets[1]!.emit("open");
    await tick();
    mock.sockets[1]!.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "response.completed", response: { id: "r" } })),
      false,
    );
    await result;
    expect(refresh).toHaveBeenCalledTimes(1);

    const controller = new AbortController();
    const aborted = collect(
      client.responses({ model: "gpt", history: [] }, controller.signal),
    );
    mock.sockets[2]!.emit("open");
    await tick();
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    expect(mock.sockets[2]!.terminated).toBe(true);
    expect([...mock.sockets[2]!.listeners.values()].flat()).toHaveLength(0);
  });
});
