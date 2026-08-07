/**
 * Slack 알림 (chat.postMessage).
 *
 * fail-open: env 미설정이면 조용히 no-op 이고, 전송 실패는 warn 로그로만 남긴다.
 * 알림 경로가 토큰 라우팅이나 오류 전파를 지연·차단해서는 안 된다.
 */
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["qgrid", "slack"]);

const SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";
const SLACK_TIMEOUT_MS = 5_000;

export async function notifySlack(text: string): Promise<void> {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL_ID;
  if (!botToken || !channel) {
    logger.debug(`slack not configured, skipping notification: ${text}`);
    return;
  }

  try {
    const res = await fetch(SLACK_POST_MESSAGE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${botToken}`,
      },
      body: JSON.stringify({ channel, text }),
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
