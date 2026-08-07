/**
 * 세션 만료(auth-dead) 토큰의 라우팅 제외 지점.
 *
 * refresh 가 재로그인 외 복구 불가한 실패를 반환한 순간에만 호출된다. 비활성화는
 * `active=true` 조건부 갱신 1회이고, 그 갱신을 이긴 프로세스만 Slack 알림을 보낸다 —
 * 공유 DB 를 쓰는 인스턴스가 몇이든 사건당 알림은 1건이다.
 */
import { getLogger } from "@logtape/logtape";

import { getRefreshToken } from "../../utils/providers/common/credentials";
import { notifySlack, SLACK_COLOR } from "../../utils/slack-notify";
import { TokenModel } from "../token/token.model";

const logger = getLogger(["qgrid", "token-death"]);

type DeadTokenRef = {
  id: number;
  name: string;
  provider: string;
};

/**
 * @param usedRefreshToken 실패한 요청이 실제로 사용한 refresh token.
 *   refresh token 은 회전 저장되므로, 이미 회전된 옛 토큰으로 늦게 도착한 재시도가
 *   400 을 받는 것은 정상 레이스다. DB 의 현재 값과 다르면 사망으로 보지 않는다.
 * @param reasonCode `provider:code` 형태의 내부 코드. provider 응답 본문에는 계정 이메일이나
 *   토큰 조각이 섞일 수 있어 raw 메시지를 그대로 알림에 싣지 않는다.
 */
export async function deactivateAuthDeadToken(
  token: DeadTokenRef,
  usedRefreshToken: string,
  reasonCode: string,
): Promise<boolean> {
  const current = await TokenModel.findOne("A", { id: token.id });
  if (!current) return false;

  const currentRefreshToken = getRefreshToken(current.credentials);
  if (currentRefreshToken && currentRefreshToken !== usedRefreshToken) {
    logger.info(
      `skipping auth-death for ${token.name}(id=${token.id}): refresh token rotated since this attempt`,
    );
    return false;
  }

  const { deactivated, keptAsLastActive } = await TokenModel.deactivateIfActive(token.id);
  if (!deactivated) {
    if (keptAsLastActive) notifyLastActiveTokenDying(token, reasonCode);
    return false;
  }

  logger.warn(`token deactivated (auth dead): ${token.name}(id=${token.id}) reason=${reasonCode}`);
  void notifySlack({
    title: "세션 만료",
    subject: token.name,
    context: `${token.provider} · ${reasonCode} · 재로그인이 필요합니다`,
    color: SLACK_COLOR.bad,
  });
  return true;
}

/**
 * 마지막 활성 토큰이 죽었을 때의 알림 쿨다운.
 *
 * 이 경우 토큰은 비활성화되지 않고 살아남으므로, 뒤따르는 요청마다 같은 실패를 반복해
 * 알림이 폭주한다. 비활성화 성공 경로가 조건부 UPDATE 로 중복을 막는 것과 달리 여기엔
 * 상태 변화가 없어 DB 로 억제할 수 없다 — provider 단위로 시간 창을 둔다.
 */
const LAST_ACTIVE_ALERT_COOLDOWN_MS = 30 * 60 * 1000;
const lastActiveAlertAt = new Map<string, number>();

function notifyLastActiveTokenDying(token: DeadTokenRef, reasonCode: string): void {
  const now = Date.now();
  const previous = lastActiveAlertAt.get(token.provider);
  if (previous !== undefined && now - previous < LAST_ACTIVE_ALERT_COOLDOWN_MS) return;
  lastActiveAlertAt.set(token.provider, now);

  void notifySlack({
    title: "마지막 토큰 사망",
    subject: token.name,
    context:
      `${token.provider} · ${reasonCode} · 풀이 비지 않도록 유지 중입니다. ` +
      `전 토큰이 동시에 실패했다면 client_id 취소나 OAuth 계약 변경을 의심하세요`,
    color: SLACK_COLOR.bad,
  });
}

/** 로그인이 완료돼 토큰이 저장됐을 때. 신규·재로그인을 가리지 않는다. */
export function notifyTokenAdded(name: string, provider: string): void {
  logger.info(`token added: ${name} (${provider})`);
  void notifySlack({
    title: "토큰 추가",
    subject: name,
    context: `${provider} · 요청 처리에 사용됩니다`,
    color: SLACK_COLOR.good,
  });
}
