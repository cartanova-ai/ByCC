import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isQuietHours } from "./quiet-hours";
import { notifySlack, SLACK_COLOR, type SlackNotification } from "./slack-notify";

const settingMock = vi.fn();

const notify = (notification: SlackNotification) => notifySlack(notification, settingMock);

/** 한국 시간을 UTC 로 표현한다 — dev0 가 UTC 라 이 변환이 실제 운영 조건이다. */
function seoul(iso: string): Date {
  return new Date(`${iso}+09:00`);
}

/** 저장값도 env 도 없는 상태 — 조용 시간이 코드 기본값(20~8시, 주말 차단)으로 동작한다. */
const noSettings = () => undefined;

/** 평일 업무 시간. 조용 시간에 막히지 않도록 전송 케이스의 기준 시각으로 쓴다. */
const WORKING_HOURS = seoul("2026-08-05T14:00:00");

describe("notifySlack", () => {
  beforeEach(() => {
    settingMock.mockImplementation((key: string) =>
      key === "slack.botToken" ? "xoxb-test" : key === "slack.channelId" ? "C123" : undefined,
    );
  });

  afterEach(() => {
    settingMock.mockReset();
    vi.restoreAllMocks();
  });

  it("posts the message to the configured channel", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    await notify({
      title: "토큰 추가",
      subject: "anthropic/test-token",
      context: "anthropic · 요청 처리에 사용됩니다",
      color: SLACK_COLOR.good,
      now: WORKING_HOURS,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      channel: "C123",
      attachments: [
        {
          // 최상위 text 가 아니라 attachment fallback 이어야 본문 제목과 겹치지 않는다.
          fallback: "토큰 추가 — anthropic/test-token",
          color: SLACK_COLOR.good,
          blocks: [
            {
              type: "section",
              text: { type: "mrkdwn", text: "*토큰 추가*  `anthropic/test-token`" },
            },
            {
              type: "context",
              elements: [{ type: "mrkdwn", text: "anthropic · 요청 처리에 사용됩니다" }],
            },
          ],
        },
      ],
    });
    expect((init as RequestInit).signal).toBeDefined();
  });

  it("omits the context block and color when they are not given", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    await notify({ title: "제목만", now: WORKING_HOURS });

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string) as {
      text?: string;
      attachments: [{ fallback: string; color?: string; blocks: unknown[] }];
    };
    // 최상위 text 를 보내지 않아야 blocks 렌더 화면에서 제목이 중복되지 않는다.
    expect(body.text).toBeUndefined();
    expect(body.attachments[0].fallback).toBe("제목만");
    expect(body.attachments[0].color).toBeUndefined();
    expect(body.attachments[0].blocks).toHaveLength(1);
  });

  it("skips the request entirely when Slack is not configured", async () => {
    settingMock.mockReturnValue(undefined);
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(notify({ title: "hello", now: WORKING_HOURS })).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("warns without throwing when Slack replies 200 with ok:false", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: "not_in_channel" })),
    );

    await expect(notify({ title: "hello", now: WORKING_HOURS })).resolves.toBeUndefined();
  });

  it("swallows network and timeout failures", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("timed out"));

    await expect(notify({ title: "hello", now: WORKING_HOURS })).resolves.toBeUndefined();
  });

  it("조용 시간에는 보통 알림을 보내지 않는다", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await notify({ title: "세션 만료", now: seoul("2026-08-05T22:00:00") });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("urgent 알림은 조용 시간에도 보낸다", async () => {
    // provider 전체가 죽은 상황은 다음 근무일까지 미룰 수 없다.
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    await notify({
      title: "마지막 토큰 사망",
      urgent: true,
      now: seoul("2026-08-05T22:00:00"),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("마스터 스위치를 내리면 보통 알림을 보내지 않는다", async () => {
    // 연휴처럼 규칙으로 잡을 수 없는 기간에 관리자가 직접 내리는 스위치.
    settingMock.mockImplementation((key: string) =>
      key === "slack.botToken"
        ? "xoxb-test"
        : key === "slack.channelId"
          ? "C123"
          : key === "slack.enabled"
            ? "false"
            : undefined,
    );
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await notify({ title: "토큰 추가", now: WORKING_HOURS });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("마스터 스위치를 내려도 urgent 는 통과한다", async () => {
    // 끈 채로 provider 가 전부 죽으면 연휴 내내 서비스 정지를 아무도 모른다.
    settingMock.mockImplementation((key: string) =>
      key === "slack.botToken"
        ? "xoxb-test"
        : key === "slack.channelId"
          ? "C123"
          : key === "slack.enabled"
            ? "false"
            : undefined,
    );
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    await notify({ title: "마지막 토큰 사망", urgent: true, now: WORKING_HOURS });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("isQuietHours 설정", () => {

  /** 설정 조회를 고정해 실행 환경의 env 에 기대지 않게 한다. */
  const withSettings = (values: Record<string, string>) => (key: string) => values[key];

  it("조용 시간 구간을 설정으로 바꾼다", () => {
    const read = withSettings({ "slack.quietFromHour": "22", "slack.quietUntilHour": "6" });
    // 21시는 기본값(20시 시작)이면 조용하지만 22시 시작으로 바꾸면 알린다.
    expect(isQuietHours(seoul("2026-08-05T21:00:00"), read)).toBe(false);
    expect(isQuietHours(seoul("2026-08-05T22:00:00"), read)).toBe(true);
    expect(isQuietHours(seoul("2026-08-06T05:59:00"), read)).toBe(true);
    expect(isQuietHours(seoul("2026-08-06T06:00:00"), read)).toBe(false);
  });

  it("주말 알림을 켜면 주말에도 시간 규칙만 본다", () => {
    const read = withSettings({ "slack.notifyOnWeekends": "true" });
    // 2026-08-08 토요일
    expect(isQuietHours(seoul("2026-08-08T10:00:00"), read)).toBe(false);
    expect(isQuietHours(seoul("2026-08-08T22:00:00"), read)).toBe(true);
  });

  it("시작과 종료가 같으면 조용 시간을 두지 않는다", () => {
    const read = withSettings({ "slack.quietFromHour": "8", "slack.quietUntilHour": "8" });
    expect(isQuietHours(seoul("2026-08-05T03:00:00"), read)).toBe(false);
    expect(isQuietHours(seoul("2026-08-05T23:00:00"), read)).toBe(false);
  });

  it("시작이 종료보다 빠르면 같은 날 구간으로 읽는다", () => {
    // 야간 근무처럼 낮에 조용하고 싶은 경우를 막지 않는다.
    const read = withSettings({ "slack.quietFromHour": "9", "slack.quietUntilHour": "18" });
    expect(isQuietHours(seoul("2026-08-05T12:00:00"), read)).toBe(true);
    expect(isQuietHours(seoul("2026-08-05T20:00:00"), read)).toBe(false);
  });

  it("범위를 벗어난 값은 기본 구간으로 떨어진다", () => {
    // 저장을 막고 있지만 env 로도 들어올 수 있어 런타임에서 한 번 더 지킨다.
    const read = withSettings({ "slack.quietFromHour": "99", "slack.quietUntilHour": "-1" });
    expect(isQuietHours(seoul("2026-08-05T21:00:00"), read)).toBe(true);
    expect(isQuietHours(seoul("2026-08-05T14:00:00"), read)).toBe(false);
  });
});

describe("isQuietHours", () => {
  it("평일 업무 시간에는 알린다", () => {
    // 2026-08-05 는 수요일
    expect(isQuietHours(seoul("2026-08-05T09:00:00"), noSettings)).toBe(false);
    expect(isQuietHours(seoul("2026-08-05T19:59:00"), noSettings)).toBe(false);
  });

  it("평일 20시부터 다음날 8시까지 조용하다", () => {
    expect(isQuietHours(seoul("2026-08-05T20:00:00"), noSettings)).toBe(true);
    expect(isQuietHours(seoul("2026-08-06T00:00:00"), noSettings)).toBe(true);
    expect(isQuietHours(seoul("2026-08-06T07:59:00"), noSettings)).toBe(true);
    expect(isQuietHours(seoul("2026-08-06T08:00:00"), noSettings)).toBe(false);
  });

  it("주말은 시간과 무관하게 조용하다", () => {
    // 2026-08-08 토요일, 08-09 일요일
    expect(isQuietHours(seoul("2026-08-08T10:00:00"), noSettings)).toBe(true);
    expect(isQuietHours(seoul("2026-08-09T12:00:00"), noSettings)).toBe(true);
  });

  it("월요일 8시에 다시 알리기 시작한다", () => {
    expect(isQuietHours(seoul("2026-08-10T07:59:00"), noSettings)).toBe(true);
    expect(isQuietHours(seoul("2026-08-10T08:00:00"), noSettings)).toBe(false);
  });

  it("서버가 UTC 여도 한국 시간으로 판정한다", () => {
    // UTC 23시 = 한국 다음날 08시 → 업무 시간
    expect(isQuietHours(new Date("2026-08-04T23:00:00Z"), noSettings)).toBe(false);
    // UTC 12시 = 한국 21시 → 조용 시간
    expect(isQuietHours(new Date("2026-08-05T12:00:00Z"), noSettings)).toBe(true);
    // UTC 금요일 22시 = 한국 토요일 07시 → 주말
    expect(isQuietHours(new Date("2026-08-07T22:00:00Z"), noSettings)).toBe(true);
  });
});
