import crypto from "node:crypto";

import WsClient, { type ClientOptions, type RawData } from "ws";

import {
  buildCodexIdentityHeaders,
  buildOpenAIResponsesRequest,
  CHATGPT_CODEX_RESPONSES_URL,
  normalizeOpenAIEvent,
  OpenAIProtocolError,
  type OpenAINormalizedEvent,
  type OpenAIResponsesOptions,
  type OpenAIResponsesRequest,
} from "./openai-backend-protocol";
import { normalizeOpenAISSE, type OpenAIEventStream } from "./openai-sse";

export interface OpenAIDirectCredentials {
  accessToken: string;
  accountId: string;
}

export interface OpenAITransportRequest {
  body: OpenAIResponsesRequest;
  signal?: AbortSignal;
  sessionId: string;
  threadId: string;
  clientRequestId: string;
}

/** Transport-independent streaming interface; HTTPS is the first implementation. */
export interface OpenAIResponsesTransport {
  stream(request: OpenAITransportRequest): OpenAIEventStream;
  close?(): void;
}

export interface OpenAIHttpsTransportOptions {
  credentials: OpenAIDirectCredentials;
  fetch?: typeof fetch;
  refreshCredentials?: () => Promise<OpenAIDirectCredentials>;
}

export interface OpenAIWebSocketLike {
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: RawData, isBinary: boolean) => void): this;
  on(event: "close", listener: (code: number, reason: Buffer) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(
    event: "unexpected-response",
    listener: (request: unknown, response: { statusCode?: number }) => void,
  ): this;
  off(event: string, listener: (...args: never[]) => void): this;
  send(data: string, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

export type OpenAIWebSocketFactory = (url: string, options: ClientOptions) => OpenAIWebSocketLike;

export interface OpenAIWebSocketTransportOptions extends OpenAIHttpsTransportOptions {
  webSocketFactory?: OpenAIWebSocketFactory;
}

type SocketRecord =
  | { kind: "open" }
  | { kind: "message"; data: RawData; isBinary: boolean }
  | { kind: "close"; code: number; reason: string }
  | { kind: "error"; error: Error }
  | { kind: "rejected"; status?: number };

const MAX_BUFFERED_SOCKET_RECORDS = 1600;

function websocketUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new OpenAIProtocolError(`Invalid OpenAI Responses URL: ${String(error)}`);
  }
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  return parsed.toString();
}

function rawDataText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString();
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString();
  return Buffer.from(data).toString();
}

function socketEvents(socket: OpenAIWebSocketLike, signal?: AbortSignal) {
  const records: SocketRecord[] = [];
  const waiters: Array<(record: SocketRecord) => void> = [];
  let active = true;
  const push = (record: SocketRecord) => {
    if (!active) return;
    const waiter = waiters.shift();
    if (waiter) waiter(record);
    else if (records.length < MAX_BUFFERED_SOCKET_RECORDS) records.push(record);
    else {
      active = false;
      records.length = 0;
      socket.terminate();
      const overflow = {
        kind: "error" as const,
        error: new OpenAIProtocolError(
          `OpenAI WebSocket exceeded the ${MAX_BUFFERED_SOCKET_RECORDS}-record receive buffer`,
          "websocket_backpressure",
        ),
      };
      const overflowWaiter = waiters.shift();
      if (overflowWaiter) overflowWaiter(overflow);
      else records.push(overflow);
    }
  };
  const onOpen = () => push({ kind: "open" });
  const onMessage = (data: RawData, isBinary: boolean) => push({ kind: "message", data, isBinary });
  const onClose = (code: number, reason: Buffer) =>
    push({ kind: "close", code, reason: reason.toString() });
  const onError = (error: Error) => push({ kind: "error", error });
  const onUnexpectedResponse = (_request: unknown, response: { statusCode?: number }) =>
    push({ kind: "rejected", status: response.statusCode });
  socket.on("open", onOpen);
  socket.on("message", onMessage);
  socket.on("close", onClose);
  socket.on("error", onError);
  socket.on("unexpected-response", onUnexpectedResponse);
  const onAbort = () => {
    socket.terminate();
    push({ kind: "error", error: abortError(signal) });
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  return {
    next: () =>
      records.length
        ? Promise.resolve(records.shift()!)
        : new Promise<SocketRecord>((resolve) => waiters.push(resolve)),
    cleanup: () => {
      active = false;
      signal?.removeEventListener("abort", onAbort);
      socket.off("open", onOpen);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      socket.off("error", onError);
      socket.off("unexpected-response", onUnexpectedResponse);
      records.length = 0;
      const closed = {
        kind: "error" as const,
        error: new OpenAIProtocolError("OpenAI WebSocket event stream was closed"),
      };
      for (const waiter of waiters.splice(0)) waiter(closed);
    },
    detachAbort: () => signal?.removeEventListener("abort", onAbort),
  };
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("Aborted", "AbortError");
}

async function nextPooledRecord(
  events: ReturnType<typeof socketEvents>,
  socket: OpenAIWebSocketLike,
  signal?: AbortSignal,
): Promise<SocketRecord> {
  if (!signal) return events.next();
  if (signal.aborted) throw abortError(signal);
  return new Promise<SocketRecord>((resolve, reject) => {
    const onAbort = () => {
      socket.terminate();
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void events
      .next()
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener("abort", onAbort);
      });
  });
}

function cacheAffinityUuid(key: string): string {
  const hex = crypto.createHash("sha256").update(key).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

export class OpenAIWebSocketTransport implements OpenAIResponsesTransport {
  private static readonly MAX_AFFINITY_CONNECTIONS = 16;
  private credentials: OpenAIDirectCredentials;
  private readonly refreshCredentials?: () => Promise<OpenAIDirectCredentials>;
  private readonly webSocketFactory: OpenAIWebSocketFactory;
  private readonly affinityConnections = new Map<
    string,
    {
      socket: OpenAIWebSocketLike;
      events: ReturnType<typeof socketEvents>;
    }
  >();
  private readonly busyAffinities = new Set<string>();

  constructor(options: OpenAIWebSocketTransportOptions) {
    this.credentials = options.credentials;
    this.refreshCredentials = options.refreshCredentials;
    this.webSocketFactory =
      options.webSocketFactory ?? ((url, wsOptions) => new WsClient(url, wsOptions));
  }

  stream(request: OpenAITransportRequest): OpenAIEventStream {
    return this.run(request);
  }

  close(): void {
    for (const { socket, events } of this.affinityConnections.values()) {
      events.cleanup();
      socket.close(1000, "transport closed");
    }
    this.affinityConnections.clear();
    this.busyAffinities.clear();
  }

  private rememberAffinityConnection(
    threadId: string,
    connection: {
      socket: OpenAIWebSocketLike;
      events: ReturnType<typeof socketEvents>;
    },
  ): void {
    if (this.affinityConnections.size >= OpenAIWebSocketTransport.MAX_AFFINITY_CONNECTIONS) {
      const oldestKey = this.affinityConnections.keys().next().value;
      if (oldestKey) {
        const oldest = this.affinityConnections.get(oldestKey)!;
        oldest.events.cleanup();
        oldest.socket.close(1000, "affinity cache evicted");
        this.affinityConnections.delete(oldestKey);
      }
    }
    this.affinityConnections.set(threadId, connection);
  }

  private async *run(request: OpenAITransportRequest): AsyncGenerator<OpenAINormalizedEvent> {
    let refreshed = false;
    while (true) {
      if (request.signal?.aborted) throw abortError(request.signal);
      const hasAffinity = request.body.prompt_cache_key !== undefined;
      const retainConnection = hasAffinity && !this.busyAffinities.has(request.threadId);
      if (retainConnection) this.busyAffinities.add(request.threadId);
      const cached = retainConnection ? this.affinityConnections.get(request.threadId) : undefined;
      const socket =
        cached?.socket ??
        this.webSocketFactory(websocketUrl(CHATGPT_CODEX_RESPONSES_URL), {
          headers: {
            ...buildCodexIdentityHeaders(this.credentials.accessToken, this.credentials.accountId, {
              sessionId: request.sessionId,
              threadId: request.threadId,
              clientRequestId: request.clientRequestId,
            }),
            "OpenAI-Beta": "responses_websockets=2026-02-06",
          },
        });
      const events = cached?.events ?? socketEvents(socket, request.signal);
      let completed = false;
      try {
        if (!cached) {
          const handshake = await events.next();
          if (
            handshake.kind === "rejected" &&
            handshake.status === 401 &&
            !refreshed &&
            this.refreshCredentials
          ) {
            socket.terminate();
            this.credentials = await this.refreshCredentials();
            refreshed = true;
            continue;
          }
          if (handshake.kind === "rejected") {
            throw new OpenAIProtocolError(
              `OpenAI WebSocket handshake rejected${handshake.status ? ` with HTTP ${handshake.status}` : ""}`,
              undefined,
              handshake.status,
            );
          }
          if (handshake.kind === "error") throw handshake.error;
          if (handshake.kind !== "open") {
            throw new OpenAIProtocolError("OpenAI WebSocket closed before the handshake completed");
          }
          if (retainConnection) {
            this.rememberAffinityConnection(request.threadId, { socket, events });
          }
        }

        await new Promise<void>((resolve, reject) => {
          socket.send(JSON.stringify({ type: "response.create", ...request.body }), (error) =>
            error ? reject(error) : resolve(),
          );
        });

        while (true) {
          const record = cached
            ? await nextPooledRecord(events, socket, request.signal)
            : await events.next();
          if (record.kind === "message") {
            if (record.isBinary) {
              throw new OpenAIProtocolError("OpenAI WebSocket sent an unexpected binary message");
            }
            let raw: unknown;
            try {
              raw = JSON.parse(rawDataText(record.data));
            } catch {
              throw new OpenAIProtocolError("OpenAI WebSocket sent invalid JSON");
            }
            const event = normalizeOpenAIEvent(raw);
            if (!event) continue;
            if (event.type === "completed") {
              completed = true;
              if (retainConnection) events.detachAbort();
              else socket.close(1000, "response completed");
              yield event;
              return;
            }
            yield event;
            if (event.type === "error") throw event.error;
          } else if (record.kind === "error") {
            throw record.error;
          } else if (record.kind === "close") {
            throw new OpenAIProtocolError(
              `OpenAI WebSocket closed before a terminal response event (${record.code}${record.reason ? `: ${record.reason}` : ""})`,
            );
          } else {
            throw new OpenAIProtocolError("OpenAI WebSocket emitted an unexpected handshake event");
          }
        }
      } finally {
        if (!completed || !retainConnection) {
          if (retainConnection) this.affinityConnections.delete(request.threadId);
          events.cleanup();
          if (!completed) socket.terminate();
        }
        if (retainConnection) this.busyAffinities.delete(request.threadId);
      }
    }
  }
}

async function responseError(response: Response): Promise<OpenAIProtocolError> {
  const text = await response.text().catch(() => "");
  let message = text || response.statusText || `HTTP ${response.status}`;
  let code: string | undefined;
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: string; code?: string } | string;
      message?: string;
      code?: string;
    };
    const error = parsed.error;
    message =
      (typeof error === "object" ? error.message : undefined) ??
      parsed.message ??
      (typeof error === "string" ? error : message);
    code = (typeof error === "object" ? error.code : undefined) ?? parsed.code;
  } catch {
    code = undefined;
  }
  return new OpenAIProtocolError(message, code, response.status);
}

export class OpenAIHttpsTransport implements OpenAIResponsesTransport {
  private credentials: OpenAIDirectCredentials;
  private readonly fetchImpl: typeof fetch;
  private readonly refreshCredentials?: () => Promise<OpenAIDirectCredentials>;

  constructor(options: OpenAIHttpsTransportOptions) {
    this.credentials = options.credentials;
    this.fetchImpl = options.fetch ?? fetch;
    this.refreshCredentials = options.refreshCredentials;
  }

  stream(request: OpenAITransportRequest): OpenAIEventStream {
    return this.run(request);
  }

  private async *run(request: OpenAITransportRequest): AsyncGenerator<OpenAINormalizedEvent> {
    let refreshed = false;

    while (true) {
      const response = await this.fetchImpl(CHATGPT_CODEX_RESPONSES_URL, {
        method: "POST",
        headers: buildCodexIdentityHeaders(
          this.credentials.accessToken,
          this.credentials.accountId,
          {
            sessionId: request.sessionId,
            threadId: request.threadId,
            clientRequestId: request.clientRequestId,
          },
        ),
        body: JSON.stringify(request.body),
        signal: request.signal,
      });

      if (response.status === 401 && !refreshed && this.refreshCredentials) {
        await response.body?.cancel();
        this.credentials = await this.refreshCredentials();
        refreshed = true;
        continue;
      }
      if (!response.ok) throw await responseError(response);
      if (!response.body) throw new OpenAIProtocolError("OpenAI response had no body");

      for await (const event of normalizeOpenAISSE(response.body)) {
        yield event;
      }
      return;
    }
  }
}

export interface OpenAIDirectClientOptions extends OpenAIHttpsTransportOptions {
  transport?: OpenAIResponsesTransport;
  transportKind?: "https" | "websocket";
  webSocketFactory?: OpenAIWebSocketFactory;
}

export class OpenAIDirectClient {
  private readonly transport: OpenAIResponsesTransport;

  constructor(options: OpenAIDirectClientOptions) {
    this.transport =
      options.transport ??
      (options.transportKind === "websocket"
        ? new OpenAIWebSocketTransport(options)
        : new OpenAIHttpsTransport(options));
  }

  responses(options: OpenAIResponsesOptions, signal?: AbortSignal): OpenAIEventStream {
    const clientRequestId = crypto.randomUUID();
    const affinityId = options.promptCacheKey
      ? cacheAffinityUuid(options.promptCacheKey)
      : clientRequestId;
    return this.transport.stream({
      body: buildOpenAIResponsesRequest(
        options.promptCacheKey ? { ...options, promptCacheKey: affinityId } : options,
      ),
      signal,
      sessionId: affinityId,
      // promptCacheKey is already a one-way SDK affinity value, never a raw sessionKey.
      threadId: affinityId,
      clientRequestId,
    });
  }

  close(): void {
    this.transport.close?.();
  }
}
