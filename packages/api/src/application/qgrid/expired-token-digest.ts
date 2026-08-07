/**
 * 비활성 토큰 주기 알림.
 *
 * 사망 순간의 단발 알림(`token-death.ts`)은 그 시점에 채널을 보지 않으면 놓친다. 재로그인은
 * 사람이 해야 하는 일이라 놓치면 토큰이 계속 빠진 채로 남는다. 그래서 남아 있는 비활성
 * 토큰을 주기적으로 다시 알리고, 소유자를 멘션해 개인에게 꽂는다.
 *
 * 비활성 토큰이 없으면 보내지 않는다 — "이상 없음"을 주기적으로 알리면 채널이 무뎌진다.
 */
import { getLogger } from "@logtape/logtape";

import { notifySlack, SLACK_COLOR } from "../../utils/slack-notify";
import { TokenModel } from "../token/token.model";
import { getSlackUserMap, mentionFor } from "./slack-user-map";

const logger = getLogger(["qgrid", "expired-digest"]);

const MINUTE_MS = 60_000;

export function buildDigestContext(
  tokens: { name: string | null; provider: string }[],
  userMap: Map<string, string>,
): string {
  return tokens
    .map((token) => {
      const mention = mentionFor(token.name, userMap);
      const label = token.name ?? "unnamed";
      // 멘션이 있으면 이름 대신 멘션을 쓴다 — 둘 다 쓰면 같은 말이 두 번 나온다.
      return mention ? `${mention} ${token.provider}` : `${label} (${token.provider})`;
    })
    .join("\n");
}

async function sendDigest(userMap: Map<string, string>): Promise<void> {
  const inactive = await TokenModel.findInactive("A");
  if (inactive.length === 0) return;

  await notifySlack({
    title: `재로그인 필요 ${inactive.length}건`,
    context: buildDigestContext(inactive, userMap),
    color: SLACK_COLOR.bad,
  });
}

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * `SLACK_EXPIRY_DIGEST_INTERVAL_MINUTES` 가 양수일 때만 켜진다. 미설정·0 이면 비활성.
 *
 * 인스턴스가 여러 개면 각자 보낸다. 사망 알림과 달리 상태 변화가 없어 DB 로 억제할 수 없고,
 * 다이제스트는 하루 몇 건 수준이라 중복을 감수하는 편이 잠금 장치를 두는 것보다 낫다.
 */
export function startExpiredTokenDigest(): void {
  const minutes = Number(process.env.SLACK_EXPIRY_DIGEST_INTERVAL_MINUTES ?? 0);
  if (!Number.isFinite(minutes) || minutes <= 0) return;

  const userMap = getSlackUserMap();
  logger.info(`expired token digest every ${minutes}m (${userMap.size} user mappings)`);

  timer = setInterval(() => {
    sendDigest(userMap).catch((e) => logger.warn(`digest failed: ${(e as Error).message}`));
  }, minutes * MINUTE_MS);
}

export function stopExpiredTokenDigest(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
