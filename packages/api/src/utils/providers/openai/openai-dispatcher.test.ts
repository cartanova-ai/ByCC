import { describe, expect, it, vi } from "vitest";

import { type OpenAICredentials } from "../../../application/token/token.types";
import { type CodexAppServerWorker } from "./codex-worker";
import { OpenAIDispatcher } from "./openai-dispatcher";

function credentials(overrides: Partial<OpenAICredentials> = {}): OpenAICredentials {
  return {
    accessToken: "access",
    refreshToken: "refresh",
    accessTokenExpiresAt: Date.now() + 60_000,
    accountId: "account",
    planType: "plus",
    ...overrides,
  };
}

function fakeWorker(reusable: boolean): CodexAppServerWorker {
  return {
    kill: vi.fn(async () => {}),
    canReuseForToken: vi.fn(() => reusable),
    updateTokenState: vi.fn(),
  } as unknown as CodexAppServerWorker;
}

describe("OpenAIDispatcher token updates", () => {
  it("keeps existing workers when only OpenAI auth tokens rotate", async () => {
    const dispatcher = new OpenAIDispatcher();
    const worker = fakeWorker(true);
    const spawnWorkers = vi.spyOn(dispatcher, "spawnWorkers").mockResolvedValue(undefined);
    dispatcher.workerPool.set(1, [worker]);

    const rotated = credentials({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      idToken: "new-id",
      accessTokenExpiresAt: Date.now() + 120_000,
    });
    await dispatcher.onTokenUpdated(1, "renamed-token", rotated);

    expect(worker.kill).not.toHaveBeenCalled();
    expect(worker.updateTokenState).toHaveBeenCalledWith("renamed-token", rotated);
    expect(spawnWorkers).not.toHaveBeenCalled();
    expect(dispatcher.workerPool.get(1)).toEqual([worker]);
  });

  it("restarts workers when the OpenAI login identity changes", async () => {
    const dispatcher = new OpenAIDispatcher();
    const worker = fakeWorker(false);
    const spawnWorkers = vi.spyOn(dispatcher, "spawnWorkers").mockResolvedValue(undefined);
    dispatcher.workerPool.set(1, [worker]);

    const changedIdentity = credentials({ accountId: "other-account" });
    await dispatcher.onTokenUpdated(1, "token", changedIdentity);

    expect(worker.kill).toHaveBeenCalledTimes(1);
    expect(spawnWorkers).toHaveBeenCalledWith(1, "token", changedIdentity);
  });
});
