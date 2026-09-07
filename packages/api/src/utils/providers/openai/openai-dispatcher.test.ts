import { describe, expect, it, vi } from "vitest";

import { QuotaThresholdExceededError } from "../../../application/qgrid/qgrid.types";
import { type GenerateRequest } from "../common/provider-dispatcher";
import {
  type OpenAINormalizedEvent,
  type OpenAIResponsesOptions,
} from "./openai-backend-protocol";
import { ImageGenerationError, OpenAIDispatcher } from "./openai-dispatcher";
import { type OpenAITransportKind } from "./openai-transport-config";

const credentials = {
  accessToken: "access",
  refreshToken: "refresh",
  accessTokenExpiresAt: 1,
  accountId: "acct",
};

function config(): OpenAITransportKind {
  return "https";
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
  run: (
    options: OpenAIResponsesOptions,
    signal?: AbortSignal,
  ) => AsyncIterable<OpenAINormalizedEvent>,
) {
  return new OpenAIDispatcher(config(), { clientFactory: () => ({ responses: run }) });
}

async function* events(...values: OpenAINormalizedEvent[]) {
  yield* values;
}

async function tickTimer(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("OpenAIDispatcher direct runtime", () => {
  it("passes the resolved transport to the injectable client factory", async () => {
    const factory = vi.fn(
      (_options: import("./openai-direct-client").OpenAIDirectClientOptions) => ({
        responses: () => events({ type: "completed", responseId: "r" }),
      }),
    );
    const d = new OpenAIDispatcher("websocket", { clientFactory: factory });
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
          usage: {
            inputTokens: 8,
            cachedInputTokens: 3,
            outputTokens: 2,
            reasoningTokens: 1,
            totalTokens: 10,
          },
        },
      );
    });
    await d.onTokenAdded(7, "primary", credentials, null, 1);

    const result = await d.generate(
      request({
        systemPrompt: "system",
        effort: "high",
        reasoningSummary: "none",
        verbosity: "low",
        serviceTier: "fast",
        promptCacheKey: "cache-key",
        outputSchema: { type: "object", additionalProperties: false },
      }),
    );

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
      usage: {
        inputTokens: 8,
        cachedInputTokens: 3,
        outputTokens: 2,
        reasoningOutputTokens: 1,
        totalTokens: 10,
      },
      threadCoord: { workerId: 7, threadId: "cache-key", epoch: -1 },
    });
  });

  it("streams deltas and reports completion", async () => {
    const d = dispatcher(() =>
      events(
        { type: "text-delta", text: "a" },
        { type: "text-delta", text: "b" },
        { type: "completed", responseId: "r" },
      ),
    );
    await d.onTokenAdded(1, "one", credentials);
    const deltas: string[] = [];
    const complete = vi.fn();
    await d.generateStream(request(), {
      onDelta: (v) => deltas.push(v),
      onComplete: complete,
      onError: vi.fn(),
    });
    expect(deltas).toEqual(["a", "b"]);
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ text: "ab" }));
  });

  it("maps images and preserves image failure classifications", async () => {
    const success = dispatcher(() =>
      events(
        { type: "image", id: "i", base64: "png", mimeType: "image/png" },
        { type: "completed", responseId: "r" },
      ),
    );
    await success.onTokenAdded(1, "one", credentials);
    await expect(success.generate(request({ imageGeneration: true }))).resolves.toMatchObject({
      images: [{ data: "png" }],
    });

    const notCalled = dispatcher(() => events({ type: "completed", responseId: "r" }));
    await notCalled.onTokenAdded(1, "one", credentials);
    await expect(notCalled.generate(request({ imageGeneration: true }))).rejects.toMatchObject({
      kind: "not_called",
    });
    await expect(
      notCalled.generateStream(request({ imageGeneration: true }), {
        onDelta: vi.fn(),
        onComplete: vi.fn(),
        onError: vi.fn(),
      }),
    ).rejects.toEqual(expect.any(ImageGenerationError));
  });

  it("uses weighted routing, while preferred affinity does not advance weighted state", async () => {
    const names: string[] = [];
    const d = dispatcher(() => events({ type: "completed", responseId: "r" }));
    await d.onTokenAdded(1, "one", credentials, null, 1);
    await d.onTokenAdded(2, "two", { ...credentials, accountId: "acct2" }, null, 2);
    for (let i = 0; i < 6; i++) names.push((await d.generate(request())).tokenName);
    expect(names.filter((n) => n === "two")).toHaveLength(4);
    expect((await d.generate(request({ preferredTokenId: 1 }))).tokenName).toBe("one");
    expect((await d.generate(request())).tokenName).toBe("two");
  });

  it("required preferred token 이 없으면 다른 토큰으로 대체하지 않는다", async () => {
    const d = dispatcher(() => events({ type: "completed", responseId: "r" }));
    await d.onTokenAdded(1, "one", credentials);

    await expect(
      d.generate(request({ preferredTokenId: 99, requirePreferredToken: true })),
    ).rejects.toThrow("Preferred openai token 99 is not available");
  });

  it("required preferred token 이 threshold 를 넘으면 eligible 토큰으로 대체하지 않는다", async () => {
    const d = new OpenAIDispatcher(config(), {
      clientFactory: () => ({ responses: () => events({ type: "completed", responseId: "r" }) }),
      fetch: async () =>
        new Response(
          JSON.stringify({ rate_limits: { primary_window: { used_percent: 90 } } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    await d.onTokenAdded(1, "one", credentials, null);
    await d.onTokenAdded(2, "two", { ...credentials, accountId: "acct2" }, 80);

    const error = await d
      .generate(request({ preferredTokenId: 2, requirePreferredToken: true }))
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(QuotaThresholdExceededError);
    expect(error.message).toContain("two (threshold 80%)");
  });

  it("runs concurrent requests without queueing and tracks in-flight counts", async () => {
    const releases: Array<() => void> = [];
    const d = dispatcher(() => ({
      async *[Symbol.asyncIterator]() {
        await new Promise<void>((resolve) => releases.push(resolve));
        yield { type: "completed", responseId: "r" } as const;
      },
    }));
    await d.onTokenAdded(1, "one", credentials);

    // 동시성 상한이 없다: 토큰 하나에 세 요청이 즉시 모두 시작된다.
    const first = d.generate(request());
    const second = d.generate(request());
    const third = d.generate(request());
    await vi.waitFor(() => expect(releases).toHaveLength(3));
    expect(d.inFlight).toBe(3);

    for (const release of releases.splice(0)) release();
    await Promise.all([first, second, third]);
    expect(d.inFlight).toBe(0);
  });

  it("aborts active transport work through the caller signal", async () => {
    const d = dispatcher((_options, signal) => ({
      async *[Symbol.asyncIterator]() {
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
        yield { type: "completed", responseId: "r" } as const;
      },
    }));
    await d.onTokenAdded(1, "one", credentials);
    const controller = new AbortController();
    const pending = d.generate(request({ abortSignal: controller.signal }));
    await tickTimer();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(d.inFlight).toBe(0);
  });

  it("rechecks abort after delayed quota selection and does not start the request", async () => {
    let releaseQuota!: () => void;
    const started = vi.fn(() => events({ type: "completed", responseId: "r" }));
    const d = new OpenAIDispatcher(config(), {
      clientFactory: () => ({ responses: started }),
      fetch: async () => {
        await new Promise<void>((resolve) => (releaseQuota = resolve));
        return new Response(
          JSON.stringify({
            rate_limits: { primary_window: { used_percent: 1 } },
          }),
          { status: 200 },
        );
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

  it("enforces timeout during an active response stream", async () => {
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
    await expect(d.generate(request({ timeoutMs: 5 }))).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await expect(d.generate(request())).resolves.toMatchObject({ tokenName: "one" });
  });

  it("applies credential metadata updates while requests are active", async () => {
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

  it("retires a replaced client only after its in-flight requests finish", async () => {
    let release!: () => void;
    let call = 0;
    const close = vi.fn();
    const d = new OpenAIDispatcher(config(), {
      clientFactory: () => ({
        responses: () => ({
          async *[Symbol.asyncIterator]() {
            call++;
            if (call === 1) await new Promise<void>((resolve) => (release = resolve));
            yield { type: "completed", responseId: "r" } as const;
          },
        }),
        close,
      }),
    });
    await d.onTokenAdded(1, "old", credentials);
    const active = d.generate(request());
    await vi.waitFor(() => expect(call).toBe(1));

    await d.onTokenUpdated(1, "new", { ...credentials, accessToken: "replacement" });
    // 세대 교체는 새 요청이 새 client 를 만들 뿐, 진행 중인 client 를 끊지 않는다.
    await expect(d.generate(request())).resolves.toMatchObject({ tokenName: "new" });
    expect(close).not.toHaveBeenCalled();

    release();
    await expect(active).resolves.toMatchObject({ tokenName: "new" });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("cancels a hung quota lookup when the caller aborts", async () => {
    const started = vi.fn(() => events({ type: "completed", responseId: "r" }));
    const d = new OpenAIDispatcher(config(), {
      clientFactory: () => ({ responses: started }),
      fetch: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = (init as RequestInit | undefined)?.signal;
          if (!signal) return;
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    });
    await d.onTokenAdded(1, "one", credentials, 80);
    const controller = new AbortController();
    const pending = d.generate(request({ abortSignal: controller.signal }));
    await tickTimer();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(started).not.toHaveBeenCalled();
  });

  it("routes past an over-threshold token instead of treating it as capacity", async () => {
    const names: string[] = [];
    const d = new OpenAIDispatcher(config(), {
      clientFactory: () => ({ responses: () => events({ type: "completed", responseId: "r" }) }),
      fetch: async () =>
        new Response(
          JSON.stringify({ rate_limits: { primary_window: { used_percent: 90 } } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    // one: threshold 없음(항상 eligible), two: threshold 초과 → 항상 one 으로 라우팅된다.
    await d.onTokenAdded(1, "one", credentials, null);
    await d.onTokenAdded(2, "two", { ...credentials, accountId: "acct2" }, 80);
    for (let i = 0; i < 4; i++) names.push((await d.generate(request())).tokenName);
    expect(names).toEqual(["one", "one", "one", "one"]);
  });

  it("fails quota lookup open, gates all exceeded tokens, and recovers after lifecycle update", async () => {
    const completeClient = () => ({
      responses: () => events({ type: "completed", responseId: "r" }),
    });
    const failOpen = new OpenAIDispatcher(config(), {
      clientFactory: completeClient,
      fetch: async () => new Response("down", { status: 503 }),
    });
    await failOpen.onTokenAdded(1, "one", credentials, 80);
    await expect(failOpen.generate(request())).resolves.toMatchObject({ tokenName: "one" });

    const blocked = new OpenAIDispatcher(config(), {
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

describe("effort 어휘 해석 (Codex 카탈로그 기준)", () => {
  async function mappedEffortFor(model: string, effort: string): Promise<unknown> {
    let mapped: OpenAIResponsesOptions | undefined;
    const d = dispatcher((options) => {
      mapped = options;
      return events({ type: "completed", responseId: "r1" });
    });
    await d.onTokenAdded(7, "primary", credentials, null, 1);
    await d.generate(request({ model, effort }));
    return mapped?.reasoning?.effort;
  }

  it("모델이 지원하는 값은 그대로 보내고, 상한 초과·공개 API 어휘는 reasoning 에서 빼 백엔드 기본값을 쓴다", async () => {
    await expect(mappedEffortFor("gpt-6-astra", "ultra")).resolves.toBe("ultra");
    await expect(mappedEffortFor("gpt-5.6-terra", "ultra")).resolves.toBe("ultra");
    await expect(mappedEffortFor("gpt-5.5", "xhigh")).resolves.toBe("xhigh");
    await expect(mappedEffortFor("gpt-5.5", "max")).resolves.toBeUndefined();
    await expect(mappedEffortFor("gpt-5.6-terra", "minimal")).resolves.toBeUndefined();
  });
});
