import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { CODEX_CONFIG_TOML, CodexAppServerWorker, type StreamCallbacks } from "./codex-worker";

function createWorkerWithFakeRpc() {
  const worker = new CodexAppServerWorker({
    tokenId: 1,
    tokenName: "token",
    accessToken: "access",
    accountId: "account",
  });
  const handlers = new Map<string, (params: never) => void>();
  const rpc = {
    onNotification(method: string, handler: (params: never) => void) {
      handlers.set(method, handler);
    },
  };
  (
    worker as unknown as {
      rpc: typeof rpc;
    }
  ).rpc = rpc;
  return { worker, handlers };
}

function createWorkerWithRequestSpy() {
  const worker = new CodexAppServerWorker({
    tokenId: 1,
    tokenName: "token",
    accessToken: "access",
    accountId: "account",
  });
  const request = vi.fn(async (method: string, _params?: unknown) => {
    if (method === "thread/start") {
      return { thread: { id: "thread-1" }, model: "gpt-test" };
    }
    if (method === "turn/start") {
      return { turn: { id: "turn-1" } };
    }
    throw new Error(`unexpected request: ${method}`);
  });
  (
    worker as unknown as {
      rpc: { request: typeof request };
      ready: boolean;
    }
  ).rpc = { request };
  (
    worker as unknown as {
      ready: boolean;
    }
  ).ready = true;
  return { worker, request };
}

function createWorkerWithNotificationRpc(
  onRequest: (
    method: string,
    params: unknown,
    handlers: Map<string, (params: never) => void>,
  ) => Promise<unknown>,
) {
  const worker = new CodexAppServerWorker({
    tokenId: 1,
    tokenName: "token",
    accessToken: "access",
    accountId: "account",
  });
  const handlers = new Map<string, (params: never) => void>();
  const request = vi.fn((method: string, params?: unknown) => onRequest(method, params, handlers));
  const rpc = {
    request,
    onNotification(method: string, handler: (params: never) => void) {
      handlers.set(method, handler);
    },
  };
  (
    worker as unknown as {
      rpc: typeof rpc;
      ready: boolean;
    }
  ).rpc = rpc;
  (
    worker as unknown as {
      ready: boolean;
    }
  ).ready = true;
  return { worker, request, handlers };
}

describe("CodexAppServerWorker home isolation", () => {
  it("places worker homes under the configured OS temp directory", () => {
    const previousTmpdir = process.env.TMPDIR;
    const customTmpdir = mkdtempSync(join(tmpdir(), "qgrid-tmp-root-test-"));

    try {
      process.env.TMPDIR = customTmpdir;
      const worker = new CodexAppServerWorker({
        tokenId: 41,
        tokenName: "token",
        accessToken: "access",
        accountId: "account",
        workerIndex: 14,
      });

      expect((worker as unknown as { codexHome: string }).codexHome).toBe(
        join(customTmpdir, "qgrid-codex", "41-14"),
      );
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpdir;
      rmSync(customTmpdir, { recursive: true, force: true });
    }
  });
});

describe("CodexAppServerWorker active turn cleanup", () => {
  it("rejects a non-streaming turn when the worker process exits", async () => {
    const { worker } = createWorkerWithFakeRpc();
    const promise = (
      worker as unknown as {
        consumeTurnNotifications(threadId: string, model: string): Promise<unknown>;
      }
    ).consumeTurnNotifications("thread-1", "gpt-test");

    (
      worker as unknown as {
        failActiveTurn(error: Error): void;
      }
    ).failActiveTurn(new Error("codex worker exited while turn was running"));

    await expect(promise).rejects.toThrow("codex worker exited while turn was running");
  });

  it("notifies stream callbacks when the worker process exits", async () => {
    const { worker } = createWorkerWithFakeRpc();
    const callbacks: StreamCallbacks = {
      onDelta: vi.fn(),
      onComplete: vi.fn(),
      onError: vi.fn(),
    };
    const promise = (
      worker as unknown as {
        consumeStreamNotifications(
          threadId: string,
          model: string,
          cb: StreamCallbacks,
        ): Promise<void>;
      }
    ).consumeStreamNotifications("thread-1", "gpt-test", callbacks);

    (
      worker as unknown as {
        failActiveTurn(error: Error): void;
      }
    ).failActiveTurn(new Error("codex worker exited while turn was running"));

    await expect(promise).rejects.toThrow("codex worker exited while turn was running");
    expect(callbacks.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "codex worker exited while turn was running" }),
    );
  });

  it("rejects the stream promise when the completion callback throws", async () => {
    const { worker, handlers } = createWorkerWithFakeRpc();
    const callbacks: StreamCallbacks = {
      onDelta: vi.fn(),
      onComplete: () => {
        throw new Error("completion mapping failed");
      },
      onError: vi.fn(),
    };
    const promise = (
      worker as unknown as {
        consumeStreamNotifications(
          threadId: string,
          model: string,
          cb: StreamCallbacks,
        ): Promise<void>;
      }
    ).consumeStreamNotifications("thread-1", "gpt-test", callbacks);

    handlers.get("turn/completed")?.({
      threadId: "thread-1",
      turn: { status: "completed", durationMs: 90 },
    } as never);

    await expect(promise).rejects.toThrow("completion mapping failed");
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(
      (worker as unknown as { activeTurnAbort?: (error: Error) => void }).activeTurnAbort,
    ).toBeUndefined();
  });
});

describe("CodexAppServerWorker TTFT", () => {
  it("captures fast non-stream deltas registered before turn/start completes", async () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { worker } = createWorkerWithNotificationRpc(async (method, _params, handlers) => {
      if (method === "thread/start") {
        return { thread: { id: "thread-1" }, model: "gpt-test" };
      }
      if (method === "turn/start") {
        now = 1_025;
        handlers.get("item/agentMessage/delta")?.({
          threadId: "thread-1",
          delta: "h",
        } as never);
        now = 1_050;
        handlers.get("item/agentMessage/delta")?.({
          threadId: "thread-1",
          delta: "i",
        } as never);
        handlers.get("turn/completed")?.({
          threadId: "thread-1",
          turn: { status: "completed", durationMs: 90 },
        } as never);
        return { turn: { id: "turn-1" } };
      }
      throw new Error(`unexpected request: ${method}`);
    });

    try {
      const result = await worker.executeTurn({
        input: [{ type: "text", text: "hi", text_elements: [] }],
      });

      expect(result.text).toBe("hi");
      expect(result.ttftMs).toBe(25);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("keeps non-stream ttft null when no delta arrives", async () => {
    const { worker } = createWorkerWithNotificationRpc(async (method, _params, handlers) => {
      if (method === "thread/start") {
        return { thread: { id: "thread-1" }, model: "gpt-test" };
      }
      if (method === "turn/start") {
        handlers.get("turn/completed")?.({
          threadId: "thread-1",
          turn: { status: "completed", durationMs: 90 },
        } as never);
        return { turn: { id: "turn-1" } };
      }
      throw new Error(`unexpected request: ${method}`);
    });

    const result = await worker.executeTurn({
      input: [{ type: "text", text: "hi", text_elements: [] }],
    });

    expect(result.ttftMs).toBeNull();
  });

  it("captures stream ttft from the first delta only", async () => {
    let now = 2_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { worker } = createWorkerWithNotificationRpc(async (method, _params, handlers) => {
      if (method === "thread/start") {
        return { thread: { id: "thread-1" }, model: "gpt-test" };
      }
      if (method === "turn/start") {
        now = 2_030;
        handlers.get("item/agentMessage/delta")?.({
          threadId: "thread-1",
          delta: "a",
        } as never);
        now = 2_080;
        handlers.get("item/agentMessage/delta")?.({
          threadId: "thread-1",
          delta: "b",
        } as never);
        handlers.get("turn/completed")?.({
          threadId: "thread-1",
          turn: { status: "completed", durationMs: 120 },
        } as never);
        return { turn: { id: "turn-1" } };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const callbacks: StreamCallbacks = {
      onDelta: vi.fn(),
      onComplete: vi.fn(),
      onError: vi.fn(),
    };

    try {
      await worker.executeTurnStream(
        {
          input: [{ type: "text", text: "hi", text_elements: [] }],
        },
        callbacks,
      );

      expect(callbacks.onDelta).toHaveBeenCalledWith("a");
      expect(callbacks.onDelta).toHaveBeenCalledWith("b");
      expect(callbacks.onComplete).toHaveBeenCalledWith(
        expect.objectContaining({ text: "ab", ttftMs: 30 }),
      );
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe("CodexAppServerWorker prompt prefix", () => {
  it("uses the same base instructions with and without an output schema", async () => {
    type WorkerInternals = {
      createThread(req: unknown): Promise<{ threadId: string; model: string }>;
      startTurnOnThread(threadId: string, req: unknown): Promise<{ turnId: string }>;
    };

    const textWorker = createWorkerWithRequestSpy();
    {
      const w = textWorker.worker as unknown as WorkerInternals;
      const req = {
        input: [{ type: "text", text: "hello", text_elements: [] }],
        developerInstructions: "fixed system prompt",
      };
      const { threadId } = await w.createThread(req);
      await w.startTurnOnThread(threadId, req);
    }

    const schemaWorker = createWorkerWithRequestSpy();
    const outputSchema = {
      type: "object",
      additionalProperties: false,
      properties: { answer: { type: "string" } },
      required: ["answer"],
    };
    {
      const w = schemaWorker.worker as unknown as WorkerInternals;
      const req = {
        input: [{ type: "text", text: "hello", text_elements: [] }],
        developerInstructions: "fixed system prompt",
        outputSchema,
      };
      const { threadId } = await w.createThread(req);
      await w.startTurnOnThread(threadId, req);
    }

    const textThreadStart = textWorker.request.mock.calls.find(
      ([method]) => method === "thread/start",
    )?.[1] as { baseInstructions?: string; developerInstructions?: string } | undefined;
    const schemaThreadStart = schemaWorker.request.mock.calls.find(
      ([method]) => method === "thread/start",
    )?.[1] as { baseInstructions?: string; developerInstructions?: string } | undefined;
    expect(textThreadStart).toEqual(
      expect.objectContaining({
        baseInstructions: schemaThreadStart?.baseInstructions,
        developerInstructions: "fixed system prompt",
      }),
    );
    expect(schemaThreadStart).toEqual(
      expect.objectContaining({
        developerInstructions: "fixed system prompt",
      }),
    );

    const schemaTurnStart = schemaWorker.request.mock.calls.find(
      ([method]) => method === "turn/start",
    )?.[1];
    expect(schemaTurnStart).toEqual(expect.objectContaining({ outputSchema }));
  });
});

describe("CodexAppServerWorker image generation capture", () => {
  const IMAGE_B64 = "iVBORw0KGgoBAgMEBQYHCA==";

  function imageItem(id: string, result: string, revisedPrompt: string | null = null) {
    return { type: "imageGeneration", id, status: "generating", result, revisedPrompt };
  }

  it("captures multiple completed image items into the images array in order", async () => {
    const { worker } = createWorkerWithNotificationRpc(async (method, _params, handlers) => {
      if (method === "thread/start") return { thread: { id: "t1" }, model: "gpt-test" };
      if (method === "turn/start") {
        handlers.get("item/completed")?.({
          threadId: "t1",
          item: imageItem("img-a", IMAGE_B64, "a red circle"),
        } as never);
        handlers.get("item/completed")?.({
          threadId: "t1",
          item: imageItem("img-b", IMAGE_B64, "a blue square"),
        } as never);
        handlers.get("turn/completed")?.({
          threadId: "t1",
          turn: { status: "completed", durationMs: 100 },
        } as never);
        return { turn: { id: "turn-1" } };
      }
      throw new Error(`unexpected request: ${method}`);
    });

    const result = await worker.executeTurn({
      input: [{ type: "text", text: "two images", text_elements: [] }],
      imageGeneration: true,
    });

    expect(result.images).toHaveLength(2);
    expect(result.images?.map((i) => i.revisedPrompt)).toEqual(["a red circle", "a blue square"]);
    expect(result.images?.[0]?.data).toBe(IMAGE_B64);
    expect(result.imageAttempted).toBe(true);
  });

  it("removes generated image artifacts after a successful image turn", async () => {
    const { worker } = createWorkerWithNotificationRpc(async (method, _params, handlers) => {
      if (method === "thread/start") return { thread: { id: "t1" }, model: "gpt-test" };
      if (method === "turn/start") {
        handlers.get("item/completed")?.({
          threadId: "t1",
          item: imageItem("img-a", IMAGE_B64, "a red circle"),
        } as never);
        handlers.get("turn/completed")?.({
          threadId: "t1",
          turn: { status: "completed", durationMs: 100 },
        } as never);
        return { turn: { id: "turn-1" } };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const codexHome = mkdtempSync(join(tmpdir(), "qgrid-codex-worker-test-"));
    const generatedImages = join(codexHome, "generated_images", "session");
    mkdirSync(generatedImages, { recursive: true });
    writeFileSync(join(generatedImages, "img-a.png"), "image");
    (worker as unknown as { codexHome: string }).codexHome = codexHome;

    try {
      await worker.executeTurn({
        input: [{ type: "text", text: "two images", text_elements: [] }],
        imageGeneration: true,
      });

      expect(existsSync(join(codexHome, "generated_images"))).toBe(false);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("treats status='generating' completed item with valid base64 as a finished image", async () => {
    const { worker } = createWorkerWithNotificationRpc(async (method, _params, handlers) => {
      if (method === "thread/start") return { thread: { id: "t1" }, model: "gpt-test" };
      if (method === "turn/start") {
        // 실측: 완료 item 의 status 가 "generating" 으로 와도 result 는 완성 base64.
        handlers.get("item/completed")?.({
          threadId: "t1",
          item: imageItem("img-a", IMAGE_B64),
        } as never);
        handlers.get("turn/completed")?.({
          threadId: "t1",
          turn: { status: "completed", durationMs: 50 },
        } as never);
        return { turn: { id: "turn-1" } };
      }
      throw new Error(`unexpected request: ${method}`);
    });

    const result = await worker.executeTurn({
      input: [{ type: "text", text: "img", text_elements: [] }],
      imageGeneration: true,
    });
    expect(result.images).toHaveLength(1);
  });

  it("dedups repeated completed events for the same item id", async () => {
    const { worker } = createWorkerWithNotificationRpc(async (method, _params, handlers) => {
      if (method === "thread/start") return { thread: { id: "t1" }, model: "gpt-test" };
      if (method === "turn/start") {
        handlers.get("item/completed")?.({ threadId: "t1", item: imageItem("dup", IMAGE_B64) } as never);
        handlers.get("item/completed")?.({ threadId: "t1", item: imageItem("dup", IMAGE_B64) } as never);
        handlers.get("turn/completed")?.({
          threadId: "t1",
          turn: { status: "completed", durationMs: 50 },
        } as never);
        return { turn: { id: "turn-1" } };
      }
      throw new Error(`unexpected request: ${method}`);
    });

    const result = await worker.executeTurn({
      input: [{ type: "text", text: "img", text_elements: [] }],
      imageGeneration: true,
    });
    expect(result.images).toHaveLength(1);
  });

  it("marks imageAttempted but returns no images when only item/started fires (tool called, not finished)", async () => {
    const { worker } = createWorkerWithNotificationRpc(async (method, _params, handlers) => {
      if (method === "thread/start") return { thread: { id: "t1" }, model: "gpt-test" };
      if (method === "turn/start") {
        handlers.get("item/started")?.({
          threadId: "t1",
          item: { type: "imageGeneration", id: "img-a", status: "in_progress", result: "", revisedPrompt: null },
        } as never);
        handlers.get("turn/completed")?.({
          threadId: "t1",
          turn: { status: "completed", durationMs: 50 },
        } as never);
        return { turn: { id: "turn-1" } };
      }
      throw new Error(`unexpected request: ${method}`);
    });

    const result = await worker.executeTurn({
      input: [{ type: "text", text: "img", text_elements: [] }],
      imageGeneration: true,
    });
    expect(result.images).toBeUndefined();
    expect(result.imageAttempted).toBe(true);
  });

  it("does not count an empty or invalid base64 result as a finished image", async () => {
    const { worker } = createWorkerWithNotificationRpc(async (method, _params, handlers) => {
      if (method === "thread/start") return { thread: { id: "t1" }, model: "gpt-test" };
      if (method === "turn/start") {
        handlers.get("item/completed")?.({ threadId: "t1", item: imageItem("empty", "") } as never);
        handlers.get("item/completed")?.({ threadId: "t1", item: imageItem("junk", "not-base64") } as never);
        handlers.get("turn/completed")?.({
          threadId: "t1",
          turn: { status: "completed", durationMs: 50 },
        } as never);
        return { turn: { id: "turn-1" } };
      }
      throw new Error(`unexpected request: ${method}`);
    });

    const result = await worker.executeTurn({
      input: [{ type: "text", text: "img", text_elements: [] }],
      imageGeneration: true,
    });
    expect(result.images).toBeUndefined();
    expect(result.imageAttempted).toBe(true);
  });

  it("discards partial images when the turn fails (no promotion to success)", async () => {
    const { worker } = createWorkerWithNotificationRpc(async (method, _params, handlers) => {
      if (method === "thread/start") return { thread: { id: "t1" }, model: "gpt-test" };
      if (method === "turn/start") {
        handlers.get("item/completed")?.({ threadId: "t1", item: imageItem("img-a", IMAGE_B64) } as never);
        handlers.get("turn/completed")?.({
          threadId: "t1",
          turn: { status: "failed", error: { message: "boom" } },
        } as never);
        return { turn: { id: "turn-1" } };
      }
      throw new Error(`unexpected request: ${method}`);
    });

    await expect(
      worker.executeTurn({
        input: [{ type: "text", text: "img", text_elements: [] }],
        imageGeneration: true,
      }),
    ).rejects.toThrow(/turn failed/);
  });

  it("does not register an image turn thread for reuse (threadMeta excluded)", async () => {
    const spy = createWorkerWithRequestSpy();
    type WorkerInternals = { createThread(req: unknown): Promise<{ threadId: string; model: string }> };
    const { threadId } = await (spy.worker as unknown as WorkerInternals).createThread({
      input: [{ type: "text", text: "img", text_elements: [] }],
      imageGeneration: true,
    });
    const threadMeta = (spy.worker as unknown as { threadMeta: Map<string, unknown> }).threadMeta;
    expect(threadMeta.has(threadId)).toBe(false);
  });

  it("still registers a normal text thread for reuse (regression guard)", async () => {
    const spy = createWorkerWithRequestSpy();
    type WorkerInternals = { createThread(req: unknown): Promise<{ threadId: string; model: string }> };
    const { threadId } = await (spy.worker as unknown as WorkerInternals).createThread({
      input: [{ type: "text", text: "hi", text_elements: [] }],
    });
    const threadMeta = (spy.worker as unknown as { threadMeta: Map<string, unknown> }).threadMeta;
    expect(threadMeta.has(threadId)).toBe(true);
  });
});

describe("CodexAppServerWorker CODEX_HOME artifacts", () => {
  it("disables bundled system skills in the generated Codex config", () => {
    expect(CODEX_CONFIG_TOML).toContain("[skills.bundled]");
    expect(CODEX_CONFIG_TOML).toContain("enabled = false");
  });

  it("removes the generated_images directory without touching other worker files", () => {
    const worker = new CodexAppServerWorker({
      tokenId: 1,
      tokenName: "token",
      accessToken: "access",
      accountId: "account",
    });
    const codexHome = mkdtempSync(join(tmpdir(), "qgrid-codex-worker-test-"));
    const generatedImages = join(codexHome, "generated_images", "session");
    mkdirSync(generatedImages, { recursive: true });
    writeFileSync(join(generatedImages, "img-a.png"), "image");
    writeFileSync(join(codexHome, "state_5.sqlite"), "state");
    (worker as unknown as { codexHome: string }).codexHome = codexHome;

    try {
      (worker as unknown as { cleanupGeneratedImages(): void }).cleanupGeneratedImages();

      expect(existsSync(join(codexHome, "generated_images"))).toBe(false);
      expect(existsSync(join(codexHome, "state_5.sqlite"))).toBe(true);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});

describe("CodexAppServerWorker image generation thread", () => {
  type WorkerInternals = {
    createThread(req: unknown): Promise<{ threadId: string; model: string }>;
  };

  function threadStartParams(spy: ReturnType<typeof createWorkerWithRequestSpy>) {
    return spy.request.mock.calls.find(([method]) => method === "thread/start")?.[1] as
      | { baseInstructions?: string; config?: Record<string, unknown> }
      | undefined;
  }

  it("enables image_generation feature and swaps base instructions for image requests", async () => {
    const spy = createWorkerWithRequestSpy();
    await (spy.worker as unknown as WorkerInternals).createThread({
      input: [{ type: "text", text: "draw a red circle", text_elements: [] }],
      imageGeneration: true,
    });

    const params = threadStartParams(spy);
    expect(params?.config).toEqual(
      expect.objectContaining({ "features.image_generation": true }),
    );
    // "text only" 억제기가 이미지 허용 instruction 으로 교체돼야 tool 이 실제로 호출된다.
    expect(params?.baseInstructions).toContain("image_generation tool");
    expect(params?.baseInstructions).not.toContain("Respond with text only");
  });

  it("leaves tool config and instructions untouched when the flag is absent", async () => {
    const spy = createWorkerWithRequestSpy();
    await (spy.worker as unknown as WorkerInternals).createThread({
      input: [{ type: "text", text: "hello", text_elements: [] }],
    });

    const params = threadStartParams(spy);
    // 회귀 가드: 이미지 플래그 없는 요청은 image_generation override 를 싣지 않고,
    // 텍스트 전용 instruction 을 유지한다(플래그 없는 경로 무변화).
    expect(params?.config).not.toHaveProperty("features.image_generation");
    expect(params?.baseInstructions).toContain("Respond with text only");
  });
});

function unsubscribedIds(request: ReturnType<typeof vi.fn>): string[] {
  return request.mock.calls
    .filter(([method]) => method === "thread/unsubscribe")
    .map(([, params]) => (params as { threadId: string }).threadId);
}

describe("CodexAppServerWorker thread unsubscribe on eviction", () => {
  type ThreadMetaInternals = {
    threadMeta: Map<string, { lastUsedAt: number }>;
    rpc: { request: ReturnType<typeof vi.fn> };
  };

  function createWorkerWithUnsubscribeSpy() {
    const worker = new CodexAppServerWorker({
      tokenId: 1,
      tokenName: "token",
      accessToken: "access",
      accountId: "account",
    });
    const request = vi.fn(async (_method: string, _params?: unknown) => ({}));
    (worker as unknown as ThreadMetaInternals).rpc = { request };
    return { worker, request, meta: (worker as unknown as ThreadMetaInternals).threadMeta };
  }

  it("sends thread/unsubscribe for TTL-expired threads", () => {
    const { worker, request, meta } = createWorkerWithUnsubscribeSpy();
    const now = Date.now();
    meta.set("stale-1", { lastUsedAt: now - 11 * 60_000 });
    meta.set("stale-2", { lastUsedAt: now - 20 * 60_000 });
    meta.set("fresh", { lastUsedAt: now });

    worker.sweepIdleThreads();

    // 맵 제거(라우팅 차단)와 구독 해제가 함께 일어나야 codex 30분 언로드가 발동한다.
    expect(meta.has("stale-1")).toBe(false);
    expect(meta.has("stale-2")).toBe(false);
    expect(meta.has("fresh")).toBe(true);
    expect(unsubscribedIds(request).toSorted()).toEqual(["stale-1", "stale-2"]);
  });

  it("sends thread/unsubscribe for LRU-evicted threads over the cap", () => {
    const { worker, request, meta } = createWorkerWithUnsubscribeSpy();
    const now = Date.now();
    for (let i = 0; i < 17; i++) {
      meta.set(`t-${i}`, { lastUsedAt: now - (17 - i) * 1_000 });
    }

    worker.sweepIdleThreads();

    // 상한(MAX-1=15)으로 줄이며 가장 오래된 2개가 축출·구독 해제된다.
    expect(meta.size).toBe(15);
    expect(unsubscribedIds(request).toSorted()).toEqual(["t-0", "t-1"]);
  });

  it("does not unsubscribe surviving threads", () => {
    const { worker, request, meta } = createWorkerWithUnsubscribeSpy();
    meta.set("live", { lastUsedAt: Date.now() });

    worker.sweepIdleThreads();

    expect(unsubscribedIds(request)).toEqual([]);
  });
});

describe("CodexAppServerWorker image thread unsubscribe", () => {
  const IMAGE_B64 = "iVBORw0KGgoBAgMEBQYHCA==";

  it("unsubscribes the one-shot image thread right after a successful turn", async () => {
    const { worker, request } = createWorkerWithNotificationRpc(
      async (method, _params, handlers) => {
        if (method === "thread/start") return { thread: { id: "t1" }, model: "gpt-test" };
        if (method === "thread/unsubscribe") return {};
        if (method === "turn/start") {
          handlers.get("item/completed")?.({
            threadId: "t1",
            item: { type: "imageGeneration", id: "img-a", status: "generating", result: IMAGE_B64, revisedPrompt: null },
          } as never);
          handlers.get("turn/completed")?.({
            threadId: "t1",
            turn: { status: "completed", durationMs: 100 },
          } as never);
          return { turn: { id: "turn-1" } };
        }
        throw new Error(`unexpected request: ${method}`);
      },
    );

    await worker.executeTurn({
      input: [{ type: "text", text: "img", text_elements: [] }],
      imageGeneration: true,
    });

    // 이미지 thread 는 threadMeta 미등록이라 sweep 이 못 잡는다 — turn 직후 즉시 구독 해제.
    expect(unsubscribedIds(request)).toEqual(["t1"]);
  });

  it("unsubscribes the image thread even when the turn fails", async () => {
    const { worker, request } = createWorkerWithNotificationRpc(
      async (method, _params, handlers) => {
        if (method === "thread/start") return { thread: { id: "t1" }, model: "gpt-test" };
        if (method === "thread/unsubscribe") return {};
        if (method === "turn/start") {
          handlers.get("turn/completed")?.({
            threadId: "t1",
            turn: { status: "failed", durationMs: 100, error: { message: "boom" } },
          } as never);
          return { turn: { id: "turn-1" } };
        }
        throw new Error(`unexpected request: ${method}`);
      },
    );

    await expect(
      worker.executeTurn({
        input: [{ type: "text", text: "img", text_elements: [] }],
        imageGeneration: true,
      }),
    ).rejects.toThrow("turn failed");

    // 실패해도 1 회용 thread 인 것은 같다 — base64 없이도 히스토리가 상주하므로 해제.
    expect(unsubscribedIds(request)).toEqual(["t1"]);
  });

  it("keeps text threads subscribed so reuse turns still receive notifications", async () => {
    const { worker, request } = createWorkerWithNotificationRpc(
      async (method, _params, handlers) => {
        if (method === "thread/start") return { thread: { id: "t1" }, model: "gpt-test" };
        if (method === "turn/start") {
          handlers.get("turn/completed")?.({
            threadId: "t1",
            turn: { status: "completed", durationMs: 100 },
          } as never);
          return { turn: { id: "turn-1" } };
        }
        throw new Error(`unexpected request: ${method}`);
      },
    );

    await worker.executeTurn({
      input: [{ type: "text", text: "hello", text_elements: [] }],
    });

    // 텍스트 thread 는 재사용 후보 — 구독을 유지해야 후속 turn 알림을 받는다.
    expect(unsubscribedIds(request)).toEqual([]);
  });
});
