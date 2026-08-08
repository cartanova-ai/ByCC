/**
 * Slack 알림 (chat.postMessage).
 *
 * fail-open: env 미설정이면 조용히 no-op 이고, 전송 실패는 warn 로그로만 남긴다.
 * 조용 시간(주말·20~8시)에는 `urgent` 가 아닌 알림을 보내지 않는다.
 * 알림 경로가 토큰 라우팅이나 오류 전파를 지연·차단해서는 안 된다.
 */
import { getLogger } from "@logtape/logtape";

import { isQuietHours } from "./quiet-hours";

const logger = getLogger(["qgrid", "slack"]);

const SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";
const SLACK_TIMEOUT_MS = 5_000;

/** 상태를 색으로 먼저 읽히게 하는 attachment 색상 바. */
export const SLACK_COLOR = {
  good: "#2eb886",
  bad: "#e01e5a",
} as const;

export type SlackNotification = {
  /** 한 줄 제목. 무슨 일이 일어났는지만 담는다. */
  title: string;
  /** 제목 옆 코드 스타일로 붙는 대상 식별자. */
  subject?: string;
  /** 제목 아래 작은 글씨로 내려가는 부가 정보 — 읽지 않아도 되는 것들. */
  context?: string;
  color?: (typeof SLACK_COLOR)[keyof typeof SLACK_COLOR];
  /**
   * 조용 시간(주말·20~8시)에도 보낸다. 서비스가 멈춘 상태처럼 지금 알지 않으면 손해가
   * 커지는 사건에만 쓴다 — 남용하면 조용 시간 자체가 무의미해진다.
   */
  urgent?: boolean;
};

export async function notifySlack(notification: SlackNotification): Promise<void> {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL_ID;
  const { title, subject, context, color, urgent } = notification;
  if (!botToken || !channel) {
    logger.debug(`slack not configured, skipping notification: ${title} ${subject ?? ""}`);
    return;
  }

  // 만료 알림은 주기적으로 반복되므로 여기서 버려도 다음 근무 시간 첫 주기에 다시 온다.
  if (!urgent && isQuietHours()) {
    logger.debug(`quiet hours, skipping notification: ${title} ${subject ?? ""}`);
    return;
  }

  const blocks: unknown[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: subject ? `*${title}*  \`${subject}\`` : `*${title}*` },
    },
  ];
  if (context) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: context }] });
  }

  try {
    const res = await fetch(SLACK_POST_MESSAGE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${botToken}`,
      },
      body: JSON.stringify({
        channel,
        // fallback 은 attachment 안에 둔다. 최상위 text 로 보내면 blocks 가 정상 렌더되는
        // 화면에서도 함께 출력돼 제목이 두 번 보인다. attachment fallback 은 blocks 를
        // 못 그리는 클라이언트와 푸시 알림에서만 쓰인다.
        attachments: [
          {
            fallback: subject ? `${title} — ${subject}` : title,
            ...(color ? { color } : {}),
            blocks,
          },
        ],
      }),
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });

    // bot 미초대(not_in_channel)·잘못된 채널 등 가장 흔한 오설정은 HTTP 200 + ok:false 로 온다.
    // status 만 보면 조용히 성공 처리돼 알림이 통째로 사라진다.
    const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (!body?.ok) {
      logger.warn(`slack notification rejected: ${body?.error ?? `http ${res.status}`}`);
    }
  } catch (e) {
    logger.warn(`slack notification failed: ${(e as Error).message}`);
  }
}
