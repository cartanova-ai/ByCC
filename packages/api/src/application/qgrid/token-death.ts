/**
 * 세션 만료(auth-dead) 토큰의 라우팅 제외 지점.
 *
 * refresh 가 재로그인 외 복구 불가한 실패를 반환한 순간에만 호출된다. 시도에 사용한
 * credentials 가 DB 와 같을 때만 reauth_required 를 기록하고, 그 기록을 이긴 프로세스만
 * Slack 알림을 보낸다 — 공유 DB 를 쓰는 인스턴스가 몇이든 사건당 알림은 1건이다.
 */
import { getLogger } from "@logtape/logtape";

import { notifySlack, SLACK_COLOR } from "../../utils/slack-notify";
import { type TokenSubsetA } from "../sonamu.generated";
import { TokenModel } from "../token/token.model";
import { getSlackUserMap, mentionFor } from "./slack-user-map";

const logger = getLogger(["qgrid", "token-death"]);

type DeadTokenRef = Pick<TokenSubsetA, "id" | "name" | "provider" | "credentials">;

/**
 * @param reasonCode `provider:code` 형태의 내부 코드. provider 응답 본문에는 계정 이메일이나
 *   토큰 조각이 섞일 수 있어 raw 메시지를 그대로 알림에 싣지 않는다.
 */
export async function deactivateAuthDeadToken(
  token: DeadTokenRef,
  reasonCode: string,
): Promise<boolean> {
  const { marked, keptAsLastActive, staleCredentials } = await TokenModel.markReauthRequired(
    token.id,
    token.credentials,
  );
  if (staleCredentials) {
    logger.info(
      `skipping auth-death for ${token.name}(id=${token.id}): credentials rotated since this attempt`,
    );
    return false;
  }
  if (!marked) return false;
  if (keptAsLastActive) {
    notifyLastActiveTokenDying(token, reasonCode);
    return false;
  }

  logger.warn(`token requires re-login: ${token.name}(id=${token.id}) reason=${reasonCode}`);
  // 만료 직후가 재로그인하기 가장 좋은 타이밍이다. 소유자를 멘션해 그 순간 당사자에게
  // 꽂는다 — 다이제스트를 기다리면 다음 주기까지 토큰이 빠진 채로 남는다.
  const mention = mentionFor(token.name, getSlackUserMap());
  void notifySlack({
    title: "세션 만료",
    subject: token.name,
    context: [mention, token.provider, reasonCode, "재로그인이 필요합니다"]
      .filter(Boolean)
      .join(" · "),
    color: SLACK_COLOR.bad,
  });
  return true;
}

function notifyLastActiveTokenDying(token: DeadTokenRef, reasonCode: string): void {
  const mention = mentionFor(token.name, getSlackUserMap());
  void notifySlack({
    title: "마지막 토큰 사망",
    subject: token.name,
    context:
      [mention, token.provider, reasonCode].filter(Boolean).join(" · ") +
      ` · 풀이 비지 않도록 유지 중입니다. ` +
      `전 토큰이 동시에 실패했다면 client_id 취소나 OAuth 계약 변경을 의심하세요`,
    color: SLACK_COLOR.bad,
    // provider 전체가 죽었다는 신호다. 조용 시간에 묻히면 다음 근무일까지 서비스가 멈춘다.
    urgent: true,
  });
}

/** 로그인이 완료돼 토큰이 저장됐을 때. 신규·재로그인을 가리지 않는다. */
export function notifyTokenAdded(name: string, provider: string): void {
  logger.info(`token added: ${name} (${provider})`);
  const mention = mentionFor(name, getSlackUserMap());
  void notifySlack({
    title: "토큰 추가",
    subject: name,
    context: [mention, provider, "요청 처리에 사용됩니다"].filter(Boolean).join(" · "),
    color: SLACK_COLOR.good,
  });
}
