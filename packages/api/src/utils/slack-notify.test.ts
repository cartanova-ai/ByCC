import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { notifySlack, SLACK_COLOR } from "./slack-notify";

// 조용 시간(주말·20~8시)에는 전송이 막힌다. 전송을 검증하는 케이스가 시계에 좌우되지
// 않도록 목으로 고정하고, 조용 시간 동작은 이 목을 뒤집어 확인한다.
const { quietMock } = vi.hoisted(() => ({ quietMock: vi.fn(() => false) }));
vi.mock("./quiet-hours", () => ({ isQuietHours: quietMock }));

describe("notifySlack", () => {
  const savedToken = process.env.SLACK_BOT_TOKEN;
  const savedChannel = process.env.SLACK_CHANNEL_ID;

  beforeEach(() => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_CHANNEL_ID = "C123";
    quietMock.mockReturnValue(false);
  });

  afterEach(() => {
    if (savedToken === undefined) delete process.env.SLACK_BOT_TOKEN;
    else process.env.SLACK_BOT_TOKEN = savedToken;
    if (savedChannel === undefined) delete process.env.SLACK_CHANNEL_ID;
    else process.env.SLACK_CHANNEL_ID = savedChannel;
    vi.restoreAllMocks();
  });

  it("posts the message to the configured channel", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    await notifySlack({
      title: "토큰 추가",
      subject: "anthropic/test-token",
      context: "anthropic · 요청 처리에 사용됩니다",
      color: SLACK_COLOR.good,
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

    await notifySlack({ title: "제목만" });

    const body = JSON.parse(
      (fetchMock.mock.calls[0]![1] as RequestInit).body as string,
    ) as { text?: string; attachments: [{ fallback: string; color?: string; blocks: unknown[] }] };
    // 최상위 text 를 보내지 않아야 blocks 렌더 화면에서 제목이 중복되지 않는다.
    expect(body.text).toBeUndefined();
    expect(body.attachments[0].fallback).toBe("제목만");
    expect(body.attachments[0].color).toBeUndefined();
    expect(body.attachments[0].blocks).toHaveLength(1);
  });

  it("skips the request entirely when env is not configured", async () => {
    delete process.env.SLACK_BOT_TOKEN;
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(notifySlack({ title: "hello" })).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("warns without throwing when Slack replies 200 with ok:false", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: "not_in_channel" })),
    );

    await expect(notifySlack({ title: "hello" })).resolves.toBeUndefined();
  });

  it("swallows network and timeout failures", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("timed out"));

    await expect(notifySlack({ title: "hello" })).resolves.toBeUndefined();
  });

  it("조용 시간에는 보통 알림을 보내지 않는다", async () => {
    quietMock.mockReturnValue(true);
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await notifySlack({ title: "세션 만료" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("urgent 알림은 조용 시간에도 보낸다", async () => {
    // provider 전체가 죽은 상황은 다음 근무일까지 미룰 수 없다.
    quietMock.mockReturnValue(true);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    await notifySlack({ title: "마지막 토큰 사망", urgent: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
