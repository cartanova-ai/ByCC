import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  KEEPALIVE_MODEL,
  KEEPALIVE_PROJECT_NAME,
  POST_KEEPALIVE_USAGE_DELAY_MS,
  rescheduleTokenWindowKeepalive,
  startTokenWindowKeepalive,
  stopTokenWindowKeepalive,
  type TokenWindowKeepaliveDeps,
} from "./token-window-keepalive";

const NOW = Date.parse("2026-08-19T00:00:00.000Z");
const FIVE_HOURS_MS = 5 * 60 * 60 * 1_000;

function token(
  id: number,
  overrides: Partial<{ name: string; provider: string; active: boolean }> = {},
) {
  return {
    id,
    name: `anthropic/token-${id}`,
    provider: "anthropic",
    active: true,
    ...overrides,
  };
}

function usage(resetsAt: string | null) {
  return {
    provider: "anthropic",
    fiveHour: { utilization: 0, resetsAt },
    sevenDay: null,
  };
}

function deps(overrides: Partial<TokenWindowKeepaliveDeps> = {}): TokenWindowKeepaliveDeps {
  return {
    findTokens: vi.fn(async () => [token(1)]),
    readUsage: vi.fn(async () => usage(new Date(NOW + FIVE_HOURS_MS).toISOString())),
    dispatch: vi.fn(async () => undefined),
    readSetting: () => "true",
    now: () => Date.now(),
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (handle) => clearTimeout(handle),
    ...overrides,
  };
}

describe("token window keepalive", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    stopTokenWindowKeepalive();
    vi.useRealTimers();
  });

  it("resetsAt 이 없으면 지정 토큰·최저가 모델·전용 project label 로 즉시 발사한다", async () => {
    const readUsage = vi
      .fn()
      .mockResolvedValueOnce(usage(null))
      .mockResolvedValueOnce(usage(new Date(NOW + FIVE_HOURS_MS).toISOString()));
    const dispatch = vi.fn(async () => undefined);

    await startTokenWindowKeepalive(deps({ readUsage, dispatch }));

    expect(dispatch).toHaveBeenCalledWith({
      prompt: "Reply OK.",
      model: KEEPALIVE_MODEL,
      effort: "low",
      projectName: KEEPALIVE_PROJECT_NAME,
      preferredTokenId: 1,
    });

    await vi.advanceTimersByTimeAsync(POST_KEEPALIVE_USAGE_DELAY_MS);
    expect(readUsage).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("resetsAt 이 과거면 즉시 발사한다", async () => {
    const dispatch = vi.fn(async () => undefined);
    await startTokenWindowKeepalive(
      deps({
        readUsage: vi.fn(async () => usage(new Date(NOW - 1).toISOString())),
        dispatch,
      }),
    );

    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("resetsAt 이 미래면 그 시각 직후까지 발사하지 않는다", async () => {
    const dispatch = vi.fn(async () => undefined);
    await startTokenWindowKeepalive(
      deps({
        readUsage: vi.fn(async () => usage(new Date(NOW + 10_000).toISOString())),
        dispatch,
      }),
    );

    await vi.advanceTimersByTimeAsync(10_999);
    expect(dispatch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("비활성 토큰과 Anthropic 이 아닌 토큰은 대상에서 제외한다", async () => {
    const readUsage = vi.fn(async () => usage(new Date(NOW + FIVE_HOURS_MS).toISOString()));
    await startTokenWindowKeepalive(
      deps({
        findTokens: vi.fn(async () => [
          token(1),
          token(2, { provider: "openai" }),
          token(3, { active: false }),
        ]),
        readUsage,
      }),
    );

    expect(readUsage).toHaveBeenCalledTimes(1);
    expect(readUsage).toHaveBeenCalledWith(1);
  });

  it("한 토큰의 usage 실패가 다른 토큰 예약을 막지 않는다", async () => {
    const readUsage = vi.fn(async (tokenId: number) => {
      if (tokenId === 1) throw new Error("usage unavailable");
      return usage(new Date(NOW + FIVE_HOURS_MS).toISOString());
    });

    await expect(
      startTokenWindowKeepalive(
        deps({ findTokens: vi.fn(async () => [token(1), token(2)]), readUsage }),
      ),
    ).resolves.toBeUndefined();

    expect(readUsage).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(2);
  });

  it("발사 실패는 밖으로 전파하지 않고 5시간 안에 재시도하지 않는다", async () => {
    const dispatch = vi.fn(async () => {
      throw new Error("provider unavailable");
    });

    await expect(
      startTokenWindowKeepalive(
        deps({ readUsage: vi.fn(async () => usage(null)), dispatch }),
      ),
    ).resolves.toBeUndefined();

    expect(dispatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(FIVE_HOURS_MS - 1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("발사 뒤 usage 에 아직 새 윈도우가 안 보여도 즉시 다시 발사하지 않는다", async () => {
    const dispatch = vi.fn(async () => undefined);
    await startTokenWindowKeepalive(
      deps({ readUsage: vi.fn(async () => usage(null)), dispatch }),
    );

    await vi.advanceTimersByTimeAsync(POST_KEEPALIVE_USAGE_DELAY_MS);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("발사 후 61초 대기 중 재스케줄되어도 같은 토큰을 다시 발사하지 않는다", async () => {
    const readUsage = vi
      .fn()
      .mockResolvedValueOnce(usage(null))
      .mockResolvedValueOnce(usage(new Date(NOW + FIVE_HOURS_MS).toISOString()));
    const dispatch = vi.fn(async () => undefined);
    const testDeps = deps({ readUsage, dispatch });

    await startTokenWindowKeepalive(testDeps);
    await rescheduleTokenWindowKeepalive(testDeps);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(readUsage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(POST_KEEPALIVE_USAGE_DELAY_MS);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(readUsage).toHaveBeenCalledTimes(2);
  });

  it("발사 실패 후 재스케줄되어도 5시간 안에 다시 발사하지 않는다", async () => {
    const dispatch = vi.fn(async () => {
      throw new Error("provider unavailable");
    });
    const testDeps = deps({ readUsage: vi.fn(async () => usage(null)), dispatch });

    await startTokenWindowKeepalive(testDeps);
    await rescheduleTokenWindowKeepalive(testDeps);
    await vi.advanceTimersByTimeAsync(FIVE_HOURS_MS - 1);

    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("스위치가 꺼져 있으면 조회나 타이머를 시작하지 않는다", async () => {
    const testDeps = deps({ readSetting: () => "false" });

    await startTokenWindowKeepalive(testDeps);

    expect(testDeps.findTokens).not.toHaveBeenCalled();
    expect(testDeps.readUsage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("실행 중 스위치를 끄고 재예약하면 기존 타이머를 정리한다", async () => {
    const testDeps = deps();
    await startTokenWindowKeepalive(testDeps);
    expect(vi.getTimerCount()).toBe(1);

    await rescheduleTokenWindowKeepalive({ ...testDeps, readSetting: () => "false" });

    expect(vi.getTimerCount()).toBe(0);
  });
});
