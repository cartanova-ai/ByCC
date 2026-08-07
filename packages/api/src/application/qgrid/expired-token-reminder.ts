/**
 * 세션 만료 알림 반복.
 *
 * 만료 순간의 알림(`token-death.ts`)은 그때 채널을 보지 않으면 놓친다. 재로그인은 사람이
 * 해야 하는 일이라 놓치면 토큰이 계속 빠진 채로 남는다. 그래서 아직 재로그인되지 않은
 * 토큰을 같은 문구로 다시 알린다 — 사건이 하나이므로 알림도 한 종류다.
 *
 * 여러 토큰이 만료돼 있으면 한 메시지에 모은다. 토큰마다 메시지를 보내면 채널이 시끄러워
 * 정작 읽히지 않는다.
 *
 * 비활성 토큰이 없으면 보내지 않는다 — "이상 없음"을 주기적으로 알리면 채널이 무뎌진다.
 */
import { getLogger } from "@logtape/logtape";

import { notifySlack, SLACK_COLOR } from "../../utils/slack-notify";
import { TokenModel } from "../token/token.model";
import { getSlackUserMap, mentionFor } from "./slack-user-map";

const logger = getLogger(["qgrid", "expired-reminder"]);

const MINUTE_MS = 60_000;

export function buildReminderContext(
  tokens: { name: string | null; provider: string }[],
  userMap: Map<string, string>,
): string {
  return tokens
    .map((token) => {
      const mention = mentionFor(token.name, userMap);
      const label = token.name ?? "unnamed";
      // 멘션이 있어도 어떤 토큰인지는 남긴다 — 한 사람이 provider 별로 여러 개를 가진다.
      return mention ? `${mention} ${label}` : label;
    })
    .join("\n");
}

async function sendReminder(userMap: Map<string, string>): Promise<void> {
  const inactive = await TokenModel.findInactive("A");
  if (inactive.length === 0) return;

  await notifySlack({
    // 만료 순간 알림과 같은 제목을 쓴다. 같은 사건이므로 다른 이름을 붙이면 별개 문제로 읽힌다.
    title: "세션 만료",
    subject: inactive.length > 1 ? `${inactive.length}건` : (inactive[0]!.name ?? "unnamed"),
    context: `${buildReminderContext(inactive, userMap)}\n재로그인이 필요합니다`,
    color: SLACK_COLOR.bad,
  });
}

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * `SLACK_EXPIRY_REMINDER_INTERVAL_MINUTES` 가 양수일 때만 켜진다. 미설정·0 이면 비활성.
 *
 * 인스턴스가 여러 개면 각자 보낸다. 만료 순간 알림과 달리 상태 변화가 없어 DB 로 억제할 수
 * 없고, 하루 몇 건 수준이라 중복을 감수하는 편이 잠금 장치를 두는 것보다 낫다.
 */
export function startExpiredTokenReminder(): void {
  const minutes = Number(process.env.SLACK_EXPIRY_REMINDER_INTERVAL_MINUTES ?? 0);
  if (!Number.isFinite(minutes) || minutes <= 0) return;

  const userMap = getSlackUserMap();
  logger.info(`expired token reminder every ${minutes}m (${userMap.size} user mappings)`);

  const run = () =>
    sendReminder(userMap).catch((e) => logger.warn(`reminder failed: ${(e as Error).message}`));

  // 기동 직후에도 한 번 보낸다. 재기동은 배포나 장애 복구 때 일어나는데, 그 시점에 이미
  // 만료된 토큰이 있으면 첫 주기가 돌 때까지 조용한 것이 이상하다.
  void run();

  timer = setInterval(run, minutes * MINUTE_MS);
}

export function stopExpiredTokenReminder(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
