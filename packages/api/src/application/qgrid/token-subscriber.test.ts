import { beforeEach, describe, expect, it, vi } from "vitest";

import { TokenSubscriber } from "./token-subscriber";

const { findOneMock, findActiveMock } = vi.hoisted(() => ({
  findOneMock: vi.fn(),
  findActiveMock: vi.fn(),
}));

vi.mock("../token/token.model", () => ({
  TokenModel: {
    findOne: findOneMock,
    findActive: findActiveMock,
  },
}));

function openaiToken(active = true) {
  return {
    id: 1,
    provider: "openai",
    active,
    name: "tok-A",
    credentials: { accessToken: "access", accountId: "account" },
    quota_threshold: 80,
  };
}

function subscriberWith(openaiDispatcher: Record<string, unknown>) {
  return new TokenSubscriber(
    {} as never,
    {
      removeCache: vi.fn(),
      upsertCache: vi.fn(),
      replaceCache: vi.fn(),
      openaiDispatcher,
      anthropicDispatcher: null,
    } as never,
  );
}

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("TokenSubscriber OpenAI notifications", () => {
  beforeEach(() => {
    findOneMock.mockReset();
    findActiveMock.mockReset();
  });

  it("updates OpenAI token metadata before activating workers", async () => {
    const calls: string[] = [];
    const openaiDispatcher = {
      onTokenUpdated: vi.fn(async () => {
        calls.push("updated");
      }),
      onTokenActivated: vi.fn(() => {
        calls.push("activated");
      }),
    };
    const subscriber = subscriberWith(openaiDispatcher);
    findOneMock.mockResolvedValueOnce(openaiToken(true));

    await subscriber.handleNotification(JSON.stringify({ op: "UPDATE", id: 1 }));
    await flushPromises();

    expect(calls).toEqual(["updated", "activated"]);
    expect(openaiDispatcher.onTokenUpdated).toHaveBeenCalledWith(
      1,
      "tok-A",
      { accessToken: "access", accountId: "account" },
      80,
    );
  });

  it("does not spawn workers for inactive OpenAI inserts", async () => {
    const openaiDispatcher = {
      onTokenAdded: vi.fn(async () => {}),
      onTokenDeactivated: vi.fn(),
    };
    const subscriber = subscriberWith(openaiDispatcher);
    findOneMock.mockResolvedValueOnce(openaiToken(false));

    await subscriber.handleNotification(JSON.stringify({ op: "INSERT", id: 1 }));

    expect(openaiDispatcher.onTokenAdded).not.toHaveBeenCalled();
    expect(openaiDispatcher.onTokenDeactivated).toHaveBeenCalledWith(1);
  });
});
