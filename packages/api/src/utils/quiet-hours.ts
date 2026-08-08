/**
 * Slack 알림 조용 시간.
 *
 * 토큰 만료는 사람이 재로그인해야 풀리는데, 그 사람이 자거나 쉬는 동안 알려도 할 수 있는
 * 일이 없다. 평일 업무 시간에만 알리고 나머지는 다음 근무 시간으로 미룬다 — 만료 알림은
 * 주기적으로 반복되므로 조용 시간에 버려도 아침 첫 주기에 다시 온다.
 *
 * 다만 provider 의 마지막 토큰이 죽는 것은 서비스 정지 신호라 이 규칙에서 제외한다
 * (호출부가 `notifySlack` 을 그냥 호출하면 된다).
 */

/** 이 시각부터(포함) 조용해진다. */
const QUIET_FROM_HOUR = 20;
/** 이 시각부터(포함) 다시 알린다. */
const QUIET_UNTIL_HOUR = 8;

/**
 * 서버가 UTC 로 돌아도 한국 시간으로 판정한다. dev0 는 UTC 이므로 `getHours()` 를 그대로
 * 쓰면 "저녁 8시"가 한국 시간 새벽 5시가 된다.
 */
function seoulParts(at: Date): { hour: number; weekday: string } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    hour: "numeric",
    hour12: false,
    weekday: "short",
  });
  const parts = formatter.formatToParts(at);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  // Intl 은 자정을 24 로 줄 수 있다. 0..23 으로 맞춘다.
  return { hour: hour % 24, weekday };
}

/** 주말이거나 20시~익일 8시면 조용 시간. */
export function isQuietHours(at: Date = new Date()): boolean {
  const { hour, weekday } = seoulParts(at);
  if (weekday === "Sat" || weekday === "Sun") return true;
  return hour >= QUIET_FROM_HOUR || hour < QUIET_UNTIL_HOUR;
}
