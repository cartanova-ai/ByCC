/**
 * Slack 알림 조용 시간.
 *
 * 토큰 만료는 사람이 재로그인해야 풀리는데, 그 사람이 자거나 쉬는 동안 알려도 할 수 있는
 * 일이 없다. 업무 시간에만 알리고 나머지는 다음 근무 시간으로 미룬다 — 만료 알림은
 * 주기적으로 반복되므로 조용 시간에 버려도 아침 첫 주기에 다시 온다.
 *
 * 다만 provider 의 마지막 토큰이 죽는 것은 서비스 정지 신호라 이 규칙에서 제외한다
 * (호출부가 `urgent: true` 로 보내면 된다).
 */
import { type getSetting } from "../application/setting/setting.store";

/**
 * 설정 조회 함수의 형태만 빌린다 — `type` import 라 런타임 의존이 생기지 않는다.
 *
 * 값 자체는 항상 호출부(`slack-notify`)가 넘긴다. 여기서 `getSetting` 을 실제로 import 하면
 * `setting.store → setting.model → token.model` 이 딸려와, `token.model` 을 mock 하는
 * 테스트들이 실제 모듈을 먼저 로드해 버린다. 조용 시간 판정은 시각 계산이지 설정 조회가
 * 아니므로, 읽는 책임은 이미 설정을 읽고 있는 호출부에 둔다.
 */
type ReadSetting = typeof getSetting;

/** `setting.constant.ts` 의 두 fallback 과 같아야 한다. 일치 여부는 테스트가 지킨다. */
export const DEFAULT_QUIET_FROM_HOUR = 20;
export const DEFAULT_QUIET_UNTIL_HOUR = 8;

/**
 * 서버가 UTC 로 돌아도 한국 시간으로 판정한다. dev0 는 UTC 이므로 `getHours()` 를 그대로
 * 쓰면 "저녁 8시"가 한국 시간 새벽 5시가 된다.
 */
const SEOUL_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Seoul",
  hour: "numeric",
  hour12: false,
  weekday: "short",
});

function seoulParts(at: Date): { hour: number; weekday: string } {
  const parts = SEOUL_FORMATTER.formatToParts(at);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  // Intl 은 자정을 24 로 줄 수 있다. 0..23 으로 맞춘다.
  return { hour: hour % 24, weekday };
}

/** 0..23 범위를 벗어나거나 숫자가 아니면 기본값으로 떨어진다. */
function boundedHour(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 23) return fallback;
  return parsed;
}

/**
 * 조용 시간인지 판정한다.
 *
 * 시작 > 종료면 자정을 넘는 구간(20시~익일 8시), 시작 < 종료면 같은 날 구간(0시~8시처럼)
 * 으로 읽는다. 야간 근무처럼 낮에 조용하고 싶은 팀도 있어 뒤집힌 값을 막지 않는다.
 */
export function isQuietHours(at: Date, readSetting: ReadSetting): boolean {
  const { hour, weekday } = seoulParts(at);

  const isWeekend = weekday === "Sat" || weekday === "Sun";
  if (isWeekend && readSetting("slack.notifyOnWeekends", "SLACK_NOTIFY_ON_WEEKENDS") !== "true") {
    return true;
  }

  const from = boundedHour(
    readSetting("slack.quietFromHour", "SLACK_QUIET_FROM_HOUR"),
    DEFAULT_QUIET_FROM_HOUR,
  );
  const until = boundedHour(
    readSetting("slack.quietUntilHour", "SLACK_QUIET_UNTIL_HOUR"),
    DEFAULT_QUIET_UNTIL_HOUR,
  );

  // 시작과 종료가 같으면 구간이 비어 있다는 뜻으로 읽어 조용 시간을 두지 않는다.
  if (from === until) return false;
  return from > until ? hour >= from || hour < until : hour >= from && hour < until;
}
