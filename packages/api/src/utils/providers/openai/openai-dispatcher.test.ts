import { describe, expect, it, vi } from "vitest";

import { type GenerateRequest } from "../common/provider-dispatcher";
import { type OpenAINormalizedEvent, type OpenAIResponsesOptions } from "./openai-backend-protocol";
import { ImageGenerationError, OpenAIDispatcher } from "./openai-dispatcher";
import { type OpenAIPermitConfig } from "./openai-permit-config";

const credentials = {
  accessToken: "access",
  refreshToken: "refresh",
  accessTokenExpiresAt: 1,
  accountId: "acct",
};

function config(capacity = 1): OpenAIPermitConfig {
  return { permitsPerToken: capacity, transport: "https" };
}

function request(overrides: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    model: "gpt-test",
    coldHistory: [{ type: "message", role: "assistant", content: "old" }],
    coldInput: [{ type: "text", text: "new", text_elements: [] }],
    ...overrides,
  };
}

function dispatcher(
  run: (options: OpenAIResponsesOptions, signal?: AbortSignal) => AsyncIterable<OpenAINormalizedEvent>,
  capacity = 1,
  timeout = 60_000,
) {
  return new OpenAIDispatcher(config(capacity), undefined, {
    queueTimeoutMs: timeout,
    clientFactory: () => ({ responses: run }),
  });
}

async function* events(...values: OpenAINormalizedEvent[]) {
  yield* values;
}

describe("OpenAIDispatcher direct runtime", () => {
  it("passes the resolved transport to the injectable client factory", async () => {
    const factory = vi.fn((_options: import("./openai-direct-client").OpenAIDirectClientOptions) => ({
      responses: () => events({ type: "completed", responseId: "r" }),
    }));
    const d = new OpenAIDispatcher(
      { permitsPerToken: 1, transport: "websocket" },
      undefined,
      { clientFactory: factory },
    );
    await d.onTokenAdded(1, "one", credentials);
    await d.generate(request());
    await d.generate(request());
    expect(factory.mock.calls[0]?.[0]).toMatchObject({ transportKind: "websocket" });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("maps complete cold context and Responses controls, then maps usage and affinity", async () => {
    let mapped: OpenAIResponsesOptions | undefined;
    const d = dispatcher((options) => {
      mapped = options;
      return events(
        { type: "text-delta", text: "hello" },
        {
          type: "completed",
          responseId: "r1",
          usage: { inputTokens: 8, cachedInputTokens: 3, outputTokens: 2, reasoningTokens: 1, totalTokens: 10 },
        },
      );
    });
    await d.onTokenAdded(7, "primary", credentials, null, 1);

    const result = await d.generate(request({
      systemPrompt: "system",
      effort: "high",
      reasoningSummary: "none",
      verbosity: "low",
      serviceTier: "fast",
      promptCacheKey: "cache-key",
      outputSchema: { type: "object", additionalProperties: false },
    }));

    expect(mapped).toMatchObject({
      model: "gpt-test",
      instructions: "system",
      reasoning: { effort: "high" },
      verbosity: "low",
      serviceTier: "priority",
      promptCacheKey: "cache-key",
      outputSchema: { schema: { type: "object", additionalProperties: false } },
    });
    expect(mapped?.reasoning).not.toHaveProperty("summary");
    expect(mapped?.history).toEqual([
      { type: "message", role: "assistant", content: "old" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "new" }] },
    ]);
    expect(result).toMatchObject({
      text: "hello",
      tokenName: "primary",
      usage: { inputTokens: 8, cachedInputTokens: 3, outputTokens: 2, reasoningOutputTokens: 1, totalTokens: 10 },
      threadCoord: { workerId: 7, threadId: "cache-key", epoch: -1 },
    });
  });

  it("streams deltas and reports completion", async () => {
    const d = dispatcher(() => events(
      { type: "text-delta", text: "a" },
      { type: "text-delta", text: "b" },
      { type: "completed", responseId: "r" },
    ));
    await d.onTokenAdded(1, "one", credentials);
    const deltas: string[] = [];
    const complete = vi.fn();
    await d.generateStream(request(), { onDelta: (v) => deltas.push(v), onComplete: complete, onError: vi.fn() });
    expect(deltas).toEqual(["a", "b"]);
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ text: "ab" }));
  });

  it("maps images and preserves image failure classifications", async () => {
    const success = dispatcher(() => events(
      { type: "image", id: "i", base64: "png", mimeType: "image/png" },
      { type: "completed", responseId: "r" },
    ));
    await success.onTokenAdded(1, "one", credentials);
    await expect(success.generate(request({ imageGeneration: true }))).resolves.toMatchObject({ images: [{ data: "png" }] });

    const notCalled = dispatcher(() => events({ type: "completed", responseId: "r" }));
    await notCalled.onTokenAdded(1, "one", credentials);
    await expect(notCalled.generate(request({ imageGeneration: true }))).rejects.toMatchObject({ kind: "not_called" });
    await expect(notCalled.generateStream(request({ imageGeneration: true }), { onDelta: vi.fn(), onComplete: vi.fn(), onError: vi.fn() })).rejects.toEqual(expect.any(ImageGenerationError));
  });

  it("uses weighted permits, while preferred affinity does not advance weighted state", async () => {
    const names: string[] = [];
    const d = dispatcher(() => events({ type: "completed", responseId: "r" }));
    await d.onTokenAdded(1, "one", credentials, null, 1);
    await d.onTokenAdded(2, "two", { ...credentials, accountId: "acct2" }, null, 2);
    for (let i = 0; i < 6; i++) names.push((await d.generate(request())).tokenName);
    expect(names.filter((n) => n === "two")).toHaveLength(4);
    expect((await d.generate(request({ preferredTokenId: 1 }))).tokenName).toBe("one");
    expect((await d.generate(request())).tokenName).toBe("two");
  });

  it("queues FIFO, reselects on release, and aborts queued and active HTTPS work", async () => {
    const releases: Array<() => void> = [];
    const d = dispatcher((_options, signal) => ({
      async *[Symbol.asyncIterator]() {
        await new Promise<void>((resolve, reject) => {
          releases.push(resolve);
          signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
        yield { type: "completed", responseId: "r" } as const;
      },
    }));
    await d.onTokenAdded(1, "one", credentials);
    const first = d.generate(request());
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    const queuedAbort = new AbortController();
    const second = d.generate(request({ abortSignal: queuedAbort.signal }));
    queuedAbort.abort();
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    const activeAbort = new AbortController();
    const third = d.generate(request({ abortSignal: activeAbort.signal }));
    releases.shift()?.();
    await first;
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    activeAbort.abort();
    await expect(third).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rechecks abort after delayed quota selection and does not start or leak a permit", async () => {
    let releaseQuota!: () => void;
    const started = vi.fn(() => events({ type: "completed", responseId: "r" }));
    const d = new OpenAIDispatcher(config(), undefined, {
      clientFactory: () => ({ responses: started }),
      fetch: async () => {
        await new Promise<void>((resolve) => (releaseQuota = resolve));
        return new Response(JSON.stringify({
          rate_limits: { primary_window: { used_percent: 1 } },
        }), { status: 200 });
      },
    });
    await d.onTokenAdded(1, "one", credentials, 80);
    const controller = new AbortController();
    const pending = d.generate(request({ abortSignal: controller.signal }));
    await vi.waitFor(() => expect(releaseQuota).toBeTypeOf("function"));
    controller.abort();
    releaseQuota();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(started).not.toHaveBeenCalled();
    await expect(d.generate(request())).resolves.toMatchObject({ tokenName: "one" });
  });

  it("enforces timeout during an active response stream and releases the permit", async () => {
    let calls = 0;
    const d = dispatcher((_options, signal) => ({
      async *[Symbol.asyncIterator]() {
        calls++;
        if (calls === 1) {
          await new Promise<void>((_resolve, reject) =>
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
          );
        }
        yield { type: "completed", responseId: "r" } as const;
      },
    }));
    await d.onTokenAdded(1, "one", credentials);
    await expect(d.generate(request({ timeoutMs: 5 }))).rejects.toMatchObject({ name: "TimeoutError" });
    await expect(d.generate(request())).resolves.toMatchObject({ tokenName: "one" });
  });

  it("times out queued admission and exposes permit compatibility stats without spawning", async () => {
    const d = dispatcher(() => ({ async *[Symbol.asyncIterator]() { await new Promise(() => {}); } }), 2, 5);
    await d.onTokenAdded(1, "one", credentials);
    expect(d.workerCount).toBe(2);
    expect(d.readyWorkerCount).toBe(2);
    void d.generate(request());
    void d.generate(request());
    await expect(d.generate(request())).rejects.toThrow("SERVER_BUSY");
    expect(d.workerCountsByToken).toEqual([{ name: "one", count: 2 }]);
  });

  it("applies credential metadata updates without leaking an active permit", async () => {
    let release!: () => void;
    let call = 0;
    const d = dispatcher(() => ({
      async *[Symbol.asyncIterator]() {
        call++;
        if (call === 1) await new Promise<void>((resolve) => (release = resolve));
        yield { type: "completed", responseId: "r" } as const;
      },
    }));
    await d.onTokenAdded(1, "old", credentials);
    const active = d.generate(request());
    await vi.waitFor(() => expect(call).toBe(1));
    await d.onTokenUpdated(1, "new", { ...credentials, accessToken: "replacement" });
    release();
    await active;
    await expect(d.generate(request())).resolves.toMatchObject({ tokenName: "new" });
  });

  it("fails quota lookup open, gates all exceeded tokens, and recovers after lifecycle update", async () => {
    const completeClient = () => ({ responses: () => events({ type: "completed", responseId: "r" }) });
    const failOpen = new OpenAIDispatcher(config(), undefined, {
      clientFactory: completeClient,
      fetch: async () => new Response("down", { status: 503 }),
    });
    await failOpen.onTokenAdded(1, "one", credentials, 80);
    await expect(failOpen.generate(request())).resolves.toMatchObject({ tokenName: "one" });

    const blocked = new OpenAIDispatcher(config(), undefined, {
      clientFactory: completeClient,
      fetch: async () =>
        new Response(
          JSON.stringify({
            rate_limits: {
              limit_id: "codex",
              primary_window: { used_percent: 90, window_minutes: 300, reset_at: 123 },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    await blocked.onTokenAdded(1, "one", credentials, 80);
    await expect(blocked.generate(request())).rejects.toBeInstanceOf(Error);
    await blocked.onTokenUpdated(1, "one", credentials, null, 1);
    await expect(blocked.generate(request())).resolves.toMatchObject({ tokenName: "one" });
    blocked.onTokenDeactivated(1);
    await expect(blocked.generate(request())).rejects.toThrow("NO_OPENAI_WORKERS");
  });
});
