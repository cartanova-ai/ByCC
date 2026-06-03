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
