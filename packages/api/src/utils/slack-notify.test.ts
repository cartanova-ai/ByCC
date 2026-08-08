import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isQuietHours } from "./quiet-hours";
import { notifySlack, SLACK_COLOR, type SlackNotification } from "./slack-notify";

const settingMock = vi.fn();

const notify = (notification: SlackNotification) => notifySlack(notification, settingMock);

/** 한국 시간을 UTC 로 표현한다 — dev0 가 UTC 라 이 변환이 실제 운영 조건이다. */
function seoul(iso: string): Date {
  return new Date(`${iso}+09:00`);
}

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
});

describe("isQuietHours", () => {
  it("평일 업무 시간에는 알린다", () => {
    // 2026-08-05 는 수요일
    expect(isQuietHours(seoul("2026-08-05T09:00:00"))).toBe(false);
    expect(isQuietHours(seoul("2026-08-05T19:59:00"))).toBe(false);
  });

  it("평일 20시부터 다음날 8시까지 조용하다", () => {
    expect(isQuietHours(seoul("2026-08-05T20:00:00"))).toBe(true);
    expect(isQuietHours(seoul("2026-08-06T00:00:00"))).toBe(true);
    expect(isQuietHours(seoul("2026-08-06T07:59:00"))).toBe(true);
    expect(isQuietHours(seoul("2026-08-06T08:00:00"))).toBe(false);
  });

  it("주말은 시간과 무관하게 조용하다", () => {
    // 2026-08-08 토요일, 08-09 일요일
    expect(isQuietHours(seoul("2026-08-08T10:00:00"))).toBe(true);
    expect(isQuietHours(seoul("2026-08-09T12:00:00"))).toBe(true);
  });

  it("월요일 8시에 다시 알리기 시작한다", () => {
    expect(isQuietHours(seoul("2026-08-10T07:59:00"))).toBe(true);
    expect(isQuietHours(seoul("2026-08-10T08:00:00"))).toBe(false);
  });

  it("서버가 UTC 여도 한국 시간으로 판정한다", () => {
    // UTC 23시 = 한국 다음날 08시 → 업무 시간
    expect(isQuietHours(new Date("2026-08-04T23:00:00Z"))).toBe(false);
    // UTC 12시 = 한국 21시 → 조용 시간
    expect(isQuietHours(new Date("2026-08-05T12:00:00Z"))).toBe(true);
    // UTC 금요일 22시 = 한국 토요일 07시 → 주말
    expect(isQuietHours(new Date("2026-08-07T22:00:00Z"))).toBe(true);
  });
});
