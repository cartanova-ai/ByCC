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
    weight: 4,
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
      4,
    );
  });

  it("passes weight to Anthropic token updates", async () => {
    const anthropicDispatcher = { onTokenUpdated: vi.fn() };
    const subscriber = new TokenSubscriber(
      {} as never,
      {
        removeCache: vi.fn(),
        upsertCache: vi.fn(),
        replaceCache: vi.fn(),
        openaiDispatcher: null,
        anthropicDispatcher,
      } as never,
    );
    findOneMock.mockResolvedValueOnce({
      ...openaiToken(true),
      provider: "anthropic",
      credentials: { accessToken: "access", refreshToken: "refresh" },
    });

    await subscriber.handleNotification(JSON.stringify({ op: "UPDATE", id: 1 }));

    expect(anthropicDispatcher.onTokenUpdated).toHaveBeenCalledWith(
      1,
      "tok-A",
      { accessToken: "access", refreshToken: "refresh" },
      80,
      4,
    );
  });

  it("Anthropic 토큰 변경 뒤 keepalive 대상 재예약을 알린다", async () => {
    const anthropicDispatcher = { onTokenAdded: vi.fn() };
    const subscriber = new TokenSubscriber(
      {} as never,
      {
        tokens: new Map(),
        removeCache: vi.fn(),
        upsertCache: vi.fn(),
        replaceCache: vi.fn(),
        openaiDispatcher: null,
        anthropicDispatcher,
      } as never,
    );
    const onTokensChanged = vi.fn();
    subscriber.setTokenChangeHandler(onTokensChanged);
    findOneMock.mockResolvedValueOnce({
      ...openaiToken(true),
      provider: "anthropic",
      credentials: { accessToken: "access", refreshToken: "refresh" },
    });

    await subscriber.handleNotification(JSON.stringify({ op: "INSERT", id: 1 }));

    expect(onTokensChanged).toHaveBeenCalledTimes(1);
  });

  it("Anthropic credentials 갱신은 keepalive 전체 재예약을 유발하지 않는다", async () => {
    const previous = {
      ...openaiToken(true),
      provider: "anthropic",
      credentials: { accessToken: "old", refreshToken: "refresh" },
    };
    const anthropicDispatcher = { onTokenUpdated: vi.fn() };
    const subscriber = new TokenSubscriber(
      {} as never,
      {
        tokens: new Map([[previous.id, previous]]),
        removeCache: vi.fn(),
        upsertCache: vi.fn(),
        replaceCache: vi.fn(),
        openaiDispatcher: null,
        anthropicDispatcher,
      } as never,
    );
    const onTokensChanged = vi.fn();
    subscriber.setTokenChangeHandler(onTokensChanged);
    findOneMock.mockResolvedValueOnce({
      ...previous,
      credentials: { accessToken: "new", refreshToken: "refresh" },
    });

    await subscriber.handleNotification(JSON.stringify({ op: "UPDATE", id: previous.id }));

    expect(anthropicDispatcher.onTokenUpdated).toHaveBeenCalledOnce();
    expect(onTokensChanged).not.toHaveBeenCalled();
  });

  it("Anthropic active 전환은 keepalive 대상 재예약을 알린다", async () => {
    const previous = {
      ...openaiToken(true),
      provider: "anthropic",
      credentials: { accessToken: "access", refreshToken: "refresh" },
    };
    const subscriber = new TokenSubscriber(
      {} as never,
      {
        tokens: new Map([[previous.id, previous]]),
        removeCache: vi.fn(),
        upsertCache: vi.fn(),
        replaceCache: vi.fn(),
        openaiDispatcher: null,
        anthropicDispatcher: { onTokenRemoved: vi.fn() },
      } as never,
    );
    const onTokensChanged = vi.fn();
    subscriber.setTokenChangeHandler(onTokensChanged);
    findOneMock.mockResolvedValueOnce({ ...previous, active: false });

    await subscriber.handleNotification(JSON.stringify({ op: "UPDATE", id: previous.id }));

    expect(onTokensChanged).toHaveBeenCalledTimes(1);
  });

  it("serializes token reloads so rapid weight updates cannot apply backward", async () => {
    let resolveFirst!: (value: ReturnType<typeof openaiToken>) => void;
    const firstRow = new Promise<ReturnType<typeof openaiToken>>((resolve) => {
      resolveFirst = resolve;
    });
    const anthropicDispatcher = { onTokenUpdated: vi.fn() };
    const subscriber = new TokenSubscriber(
      {} as never,
      {
        removeCache: vi.fn(),
        upsertCache: vi.fn(),
        replaceCache: vi.fn(),
        openaiDispatcher: null,
        anthropicDispatcher,
      } as never,
    );
    findOneMock.mockReturnValueOnce(firstRow).mockResolvedValueOnce({
      ...openaiToken(true),
      provider: "anthropic",
      weight: 5,
    });

    const first = subscriber.handleNotification(JSON.stringify({ op: "UPDATE", id: 1 }));
    const second = subscriber.handleNotification(JSON.stringify({ op: "UPDATE", id: 1 }));

    await flushPromises();
    expect(findOneMock).toHaveBeenCalledTimes(1);

    resolveFirst({ ...openaiToken(true), provider: "anthropic", weight: 2 });
    await Promise.all([first, second]);

    expect(anthropicDispatcher.onTokenUpdated.mock.calls.map((call) => call[4])).toEqual([2, 5]);
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

  it("passes weight while reconciling both provider token pools", async () => {
    const anthropicDispatcher = { replaceTokens: vi.fn() };
    const openaiDispatcher = { replaceTokens: vi.fn(async () => {}) };
    const subscriber = new TokenSubscriber(
      {} as never,
      {
        removeCache: vi.fn(),
        upsertCache: vi.fn(),
        replaceCache: vi.fn(),
        openaiDispatcher,
        anthropicDispatcher,
      } as never,
    );
    findActiveMock.mockResolvedValueOnce([
      {
        ...openaiToken(true),
        provider: "anthropic",
        credentials: { accessToken: "access-a", refreshToken: "refresh-a" },
      },
      {
        ...openaiToken(true),
        id: 2,
        name: "tok-B",
        credentials: { accessToken: "access-b", accountId: "account-b" },
      },
    ]);

    await subscriber.reconcile();

    expect(anthropicDispatcher.replaceTokens).toHaveBeenCalledWith([
      expect.objectContaining({ id: 1, quotaThreshold: 80, weight: 4 }),
    ]);
    expect(openaiDispatcher.replaceTokens).toHaveBeenCalledWith([
      expect.objectContaining({ id: 2, quotaThreshold: 80, weight: 4 }),
    ]);
  });

  it("reconcile 은 Anthropic 대상 집합이 바뀔 때만 keepalive 재예약을 알린다", async () => {
    const currentAnthropic = {
      ...openaiToken(true),
      provider: "anthropic",
      credentials: { accessToken: "access-a", refreshToken: "refresh-a" },
    };
    const dispatcher = {
      tokens: new Map([[currentAnthropic.id, currentAnthropic]]),
      replaceCache: vi.fn(),
      openaiDispatcher: null,
      anthropicDispatcher: { replaceTokens: vi.fn() },
    };
    const subscriber = new TokenSubscriber({} as never, dispatcher as never);
    const onTokensChanged = vi.fn();
    subscriber.setTokenChangeHandler(onTokensChanged);
    findActiveMock
      .mockResolvedValueOnce([currentAnthropic])
      .mockResolvedValueOnce([
        currentAnthropic,
        { ...currentAnthropic, id: 3, name: "anthropic/tok-C" },
      ]);

    await subscriber.reconcile();
    expect(onTokensChanged).not.toHaveBeenCalled();

    await subscriber.reconcile();
    expect(onTokensChanged).toHaveBeenCalledTimes(1);
  });
});
