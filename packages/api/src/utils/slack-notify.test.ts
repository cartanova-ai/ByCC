import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { notifySlack, SLACK_COLOR } from "./slack-notify";

describe("notifySlack", () => {
  const savedToken = process.env.SLACK_BOT_TOKEN;
  const savedChannel = process.env.SLACK_CHANNEL_ID;

  beforeEach(() => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_CHANNEL_ID = "C123";
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
      // blocks 만 보내면 푸시 알림이 빈칸으로 뜨므로 대체 텍스트가 함께 나가야 한다.
      text: "토큰 추가 — anthropic/test-token",
      attachments: [
        {
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
    ) as { text: string; attachments: [{ color?: string; blocks: unknown[] }] };
    expect(body.text).toBe("제목만");
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
});
