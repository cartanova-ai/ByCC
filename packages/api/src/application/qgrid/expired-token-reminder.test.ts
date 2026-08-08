import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { findInactiveMock, getSettingMock, notifySlackMock } = vi.hoisted(() => ({
  findInactiveMock: vi.fn(),
  getSettingMock: vi.fn(),
  notifySlackMock: vi.fn(),
}));

import {
  buildReminderContext,
  type ExpiredTokenReminderDeps,
  rescheduleExpiredTokenReminder,
  startExpiredTokenReminder,
  stopExpiredTokenReminder,
} from "./expired-token-reminder";
import { getSlackUserMap } from "./slack-user-map";

const userMap = new Map([
  ["yds", "U09NAJUQSFQ"],
  ["haze", "U09N96NHZB7"],
]);

describe("buildReminderContext", () => {
  it("1건이면 제목에 있는 토큰명을 본문에서 반복하지 않는다", () => {
    const text = buildReminderContext([{ name: "anthropic/yds", provider: "anthropic" }], userMap);

    expect(text).toBe("<@U09NAJUQSFQ>\n재로그인이 필요합니다");
  });

  it("1건이고 매핑이 없으면 안내만 남는다", () => {
    const text = buildReminderContext(
      [{ name: "anthropic/dev-common", provider: "anthropic" }],
      userMap,
    );

    expect(text).toBe("재로그인이 필요합니다");
  });

  it("여러 건이면 제목이 건수라 본문에 토큰명을 남긴다", () => {
    const text = buildReminderContext(
      [
        { name: "anthropic/yds", provider: "anthropic" },
        { name: "openai/yds", provider: "openai" },
      ],
      userMap,
    );

    expect(text.split("\n")).toEqual([
      "<@U09NAJUQSFQ> anthropic/yds",
      "<@U09NAJUQSFQ> openai/yds",
      "재로그인이 필요합니다",
    ]);
  });

  it("여러 건 중 매핑 없는 공용 계정은 이름만 남긴다", () => {
    const text = buildReminderContext(
      [
        { name: "anthropic/haze", provider: "anthropic" },
        { name: "anthropic/dev-common", provider: "anthropic" },
      ],
      userMap,
    );

    expect(text.split("\n")).toEqual([
      "<@U09N96NHZB7> anthropic/haze",
      "anthropic/dev-common",
      "재로그인이 필요합니다",
    ]);
  });

  it("이름이 없는 토큰도 줄을 잃지 않는다", () => {
    const text = buildReminderContext(
      [
        { name: null, provider: "openai" },
        { name: "anthropic/haze", provider: "anthropic" },
      ],
      userMap,
    );

    expect(text.split("\n")).toEqual([
      "unnamed",
      "<@U09N96NHZB7> anthropic/haze",
      "재로그인이 필요합니다",
    ]);
  });
});

describe("expired token reminder scheduling", () => {
  let minutes = "10";
  let rawUserMap = "yds:U-OLD";
  let deps: ExpiredTokenReminderDeps;

  beforeEach(() => {
    vi.useFakeTimers();
    minutes = "10";
    rawUserMap = "yds:U-OLD";
    findInactiveMock.mockReset();
    getSettingMock.mockReset();
    notifySlackMock.mockReset();
    findInactiveMock.mockResolvedValue([{ name: "anthropic/yds", provider: "anthropic" }]);
    getSettingMock.mockImplementation((key: string) => {
      if (key === "slack.expiryReminderMinutes") return minutes;
      if (key === "slack.userMap") return rawUserMap;
      return undefined;
    });
    notifySlackMock.mockResolvedValue(undefined);
    deps = {
      findInactive: findInactiveMock,
      getSlackUserMap: () => getSlackUserMap(getSettingMock),
      readSetting: getSettingMock,
      sendSlack: notifySlackMock,
    };
  });

  afterEach(() => {
    stopExpiredTokenReminder();
    vi.useRealTimers();
  });

  it("부팅 시 만료 토큰을 즉시 한 번 알린다", async () => {
    startExpiredTokenReminder(deps);
    await vi.advanceTimersByTimeAsync(0);

    expect(notifySlackMock).toHaveBeenCalledTimes(1);
  });

  it("start를 다시 호출해도 interval은 하나만 남는다", async () => {
    startExpiredTokenReminder(deps);
    startExpiredTokenReminder(deps);
    await vi.advanceTimersByTimeAsync(0);
    notifySlackMock.mockClear();

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(notifySlackMock).toHaveBeenCalledTimes(1);
  });

  it("설정 변경은 즉시 알리지 않고 새 주기로 재예약한다", async () => {
    startExpiredTokenReminder(deps);
    await vi.advanceTimersByTimeAsync(0);
    notifySlackMock.mockClear();
    minutes = "20";

    rescheduleExpiredTokenReminder(deps);
    await vi.advanceTimersByTimeAsync(19 * 60_000);
    expect(notifySlackMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(notifySlackMock).toHaveBeenCalledTimes(1);
  });

  it.each(["0", "-1", "not-a-number"])("%s로 재설정하면 기존 타이머를 멈춘다", async (next) => {
    startExpiredTokenReminder(deps);
    await vi.advanceTimersByTimeAsync(0);
    notifySlackMock.mockClear();
    minutes = next;

    rescheduleExpiredTokenReminder(deps);
    await vi.advanceTimersByTimeAsync(20 * 60_000);

    expect(notifySlackMock).not.toHaveBeenCalled();
  });

  it("각 실행 시점의 최신 Slack 사용자 매핑을 사용한다", async () => {
    startExpiredTokenReminder(deps);
    await vi.advanceTimersByTimeAsync(0);
    expect(notifySlackMock.mock.calls[0]![0]).toMatchObject({ context: "<@U-OLD>\n재로그인이 필요합니다" });
    notifySlackMock.mockClear();
    rawUserMap = "yds:U-NEW";

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(notifySlackMock.mock.calls[0]![0]).toMatchObject({ context: "<@U-NEW>\n재로그인이 필요합니다" });
  });
});
