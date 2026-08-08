/**
 * 토큰 소유자 → Slack 사용자 멘션.
 *
 * Slack 표시 이름과 토큰명이 자주 어긋나(haze→haze.lee, byeongjun→potados) `users.list`
 * 자동 매칭은 조용히 실패한다. 멘션이 빠지면 알림이 개인에게 닿지 않아 목적 자체가
 * 사라지므로 `SLACK_USER_MAP` 명시 매핑만 쓴다.
 *
 * 공용 계정(bysuco, dev-common 등)은 매핑에 넣지 않는다 — 멘션 없이 이름만 나가는 것이
 * 맞는 동작이다.
 */

import { getSetting } from "../setting/setting.store";

/** `토큰명:SlackUserId` 목록을 파싱한다. */
export function parseSlackUserMap(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw) return map;

  for (const entry of raw.split(",")) {
    const [name, userId] = entry.split(":").map((s) => s.trim());
    if (name && userId) map.set(name, userId);
  }
  return map;
}

/** `anthropic/yds` → `yds`. provider prefix 없이 저장된 이름도 그대로 받는다. */
export function ownerOf(tokenName: string | null): string {
  if (!tokenName) return "";
  const slash = tokenName.indexOf("/");
  return slash === -1 ? tokenName : tokenName.slice(slash + 1);
}

/** 매핑이 있으면 `<@U...>`, 없으면 빈 문자열. 호출부가 멘션 유무로 문구를 고른다. */
export function mentionFor(tokenName: string | null, userMap: Map<string, string>): string {
  const userId = userMap.get(ownerOf(tokenName));
  return userId ? `<@${userId}>` : "";
}

export function getSlackUserMap(readSetting: typeof getSetting = getSetting): Map<string, string> {
  return parseSlackUserMap(readSetting("slack.userMap", "SLACK_USER_MAP"));
}
