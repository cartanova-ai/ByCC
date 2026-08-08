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
import { getSetting } from "../setting/setting.store";
import { TokenModel } from "../token/token.model";
import { getSlackUserMap, mentionFor } from "./slack-user-map";

const logger = getLogger(["qgrid", "expired-reminder"]);

const MINUTE_MS = 60_000;

export type ExpiredTokenReminderDeps = {
  findInactive: () => Promise<{ name: string | null; provider: string }[]>;
  getSlackUserMap: () => Map<string, string>;
  readSetting: typeof getSetting;
  sendSlack: typeof notifySlack;
};

const defaultDeps: ExpiredTokenReminderDeps = {
  findInactive: () => TokenModel.findInactive("A"),
  getSlackUserMap,
  readSetting: getSetting,
  sendSlack: notifySlack,
};

/**
 * 1건이면 제목(subject)에 토큰명이 이미 있으므로 본문에서는 뺀다 — 같은 이름을 두 번 쓰면
 * 읽는 사람이 다른 정보인 줄 알고 한 번 더 본다. 여러 건이면 제목이 건수라 본문에 남긴다.
 */
export function buildReminderContext(
  tokens: { name: string | null; provider: string }[],
  userMap: Map<string, string>,
): string {
  const showLabel = tokens.length > 1;
  const lines = tokens.map((token) => {
    const mention = mentionFor(token.name, userMap);
    const label = token.name ?? "unnamed";
    if (!showLabel) return mention;
    return mention ? `${mention} ${label}` : label;
  });
  return [...lines, "재로그인이 필요합니다"].filter(Boolean).join("\n");
}

async function sendReminder(deps: ExpiredTokenReminderDeps, urgent = false): Promise<number> {
  const inactive = await deps.findInactive();
  if (inactive.length === 0) return 0;

  const userMap = deps.getSlackUserMap();

  await deps.sendSlack({
    // 만료 순간 알림과 같은 제목을 쓴다. 같은 사건이므로 다른 이름을 붙이면 별개 문제로 읽힌다.
    title: "세션 만료",
    subject: inactive.length > 1 ? `${inactive.length}건` : (inactive[0]!.name ?? "unnamed"),
    context: buildReminderContext(inactive, userMap),
    color: SLACK_COLOR.bad,
    urgent,
  });
  return inactive.length;
}

/**
 * 화면의 "지금 보내기". 사람이 직접 누른 것이므로 조용 시간·마스터 스위치를 통과시킨다 —
 * 눌렀는데 아무 일도 안 일어나면 버튼이 고장 난 것으로 읽힌다.
 *
 * 보낸 건수를 돌려줘 호출부가 "보낼 대상 없음"과 "보냄"을 구분해 보여준다.
 */
export function sendExpiredTokenReminderNow(
  deps: ExpiredTokenReminderDeps = defaultDeps,
): Promise<number> {
  return sendReminder(deps, true);
}

let timer: ReturnType<typeof setInterval> | null = null;

function scheduleExpiredTokenReminder(runNow: boolean, deps: ExpiredTokenReminderDeps): void {
  stopExpiredTokenReminder();

  // 주기 값과 별개인 스위치다. 꺼도 주기는 남아 있어 다시 켤 때 고르던 값이 그대로다.
  if (deps.readSetting("slack.remindersEnabled", "SLACK_REMINDERS_ENABLED") === "false") {
    logger.info("expired token reminder disabled");
    return;
  }

  const minutes = Number(
    deps.readSetting("slack.expiryReminderMinutes", "SLACK_EXPIRY_REMINDER_INTERVAL_MINUTES") ?? 0,
  );
  if (!Number.isFinite(minutes) || minutes <= 0) return;

  logger.info(
    `expired token reminder every ${minutes}m (${deps.getSlackUserMap().size} user mappings)`,
  );

  const run = () =>
    sendReminder(deps).catch((e) => logger.warn(`reminder failed: ${(e as Error).message}`));

  if (runNow) void run();
  timer = setInterval(run, minutes * MINUTE_MS);
}

/**
 * `SLACK_EXPIRY_REMINDER_INTERVAL_MINUTES` 가 양수일 때만 켜진다. 미설정·0 이면 비활성.
 *
 * 인스턴스가 여러 개면 각자 보낸다. 만료 순간 알림과 달리 상태 변화가 없어 DB 로 억제할 수
 * 없고, 하루 몇 건 수준이라 중복을 감수하는 편이 잠금 장치를 두는 것보다 낫다.
 */
export function startExpiredTokenReminder(deps: ExpiredTokenReminderDeps = defaultDeps): void {
  // 기동 직후에도 한 번 보낸다. 재기동은 배포나 장애 복구 때 일어나는데, 그 시점에 이미
  // 만료된 토큰이 있으면 첫 주기가 돌 때까지 조용한 것이 이상하다.
  scheduleExpiredTokenReminder(true, deps);
}

/** 설정 변경 시 기존 타이머만 새 주기로 교체한다. 저장 자체가 알림을 보내지는 않는다. */
export function rescheduleExpiredTokenReminder(deps: ExpiredTokenReminderDeps = defaultDeps): void {
  scheduleExpiredTokenReminder(false, deps);
}

export function stopExpiredTokenReminder(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
