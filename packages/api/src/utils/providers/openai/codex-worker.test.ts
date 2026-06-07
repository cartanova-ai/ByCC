import { describe, expect, it, vi } from "vitest";

import { CodexAppServerWorker, type StreamCallbacks } from "./codex-worker";

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
