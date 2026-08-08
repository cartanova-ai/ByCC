/**
 * 관리 가능한 런타임 설정 목록.
 *
 * 키·env 이름·타입·검증을 한 곳에 모아 API 와 UI 가 같은 정의를 본다. 여기 없는 env 는
 * 화면에서 바꿀 수 없다 — DB 접속 정보나 포트처럼 서버가 뜨기 전에 필요한 값들이다.
 */

export type SettingKind = "boolean" | "integer" | "number" | "string" | "secret";

/** 화면에서 묶어 보여줄 단위. 9개를 평평하게 나열하면 어디를 봐야 할지 알 수 없다. */
export type SettingGroup = "openai" | "slack";

export type SettingDef = {
  key: string;
  group: SettingGroup;
  envKey: string;
  label: string;
  kind: SettingKind;
  /** 적용 시점. 워커 설정은 dispatcher 생성자에서 한 번만 읽혀 재시작이 필요하다. */
  applies: "immediate" | "restart";
  min?: number;
  max?: number;
  /**
   * 저장값도 env 도 없을 때 실제로 적용되는 값. 화면을 비워두면 "설정 안 됨"으로 읽히지만
   * 실제로는 이 값이 돌고 있다 — 소비처의 기본값과 반드시 같아야 한다.
   */
  fallback: string;
  help?: string;
};

/** 64 GiB 운영 호스트에서 세 자리 오입력을 막는 설정 상한. 안전을 보장하는 값은 아니다. */
export const MAX_OPENAI_ESTIMATED_RSS_GIB = 32;
export const MAX_OPENAI_MIN_HOST_AVAILABLE_GIB = 64;

export const SETTING_DEFS: SettingDef[] = [
  {
    key: "openai.autoscale",
    fallback: "true",
    group: "openai",
    envKey: "QGRID_OPENAI_AUTOSCALE",
    label: "OpenAI 워커 오토스케일",
    kind: "boolean",
    applies: "restart",
    help: "끄면 워커 수가 최소값으로 고정됩니다",
  },
  {
    key: "openai.minWorkersPerToken",
    fallback: "1",
    group: "openai",
    envKey: "QGRID_OPENAI_MIN_WORKERS_PER_TOKEN",
    label: "토큰당 최소 워커",
    kind: "integer",
    applies: "restart",
    min: 1,
    max: 20,
  },
  {
    key: "openai.maxWorkersPerToken",
    fallback: "3",
    group: "openai",
    envKey: "QGRID_OPENAI_MAX_WORKERS_PER_TOKEN",
    label: "토큰당 최대 워커",
    kind: "integer",
    applies: "restart",
    min: 1,
    max: 20,
    help: "오토스케일이 꺼져 있으면 무시됩니다",
  },
  {
    key: "openai.maxEstimatedRssGiB",
    fallback: "16",
    group: "openai",
    envKey: "QGRID_OPENAI_MAX_ESTIMATED_RSS_GIB",
    label: "워커 메모리 상한 (GiB)",
    kind: "number",
    applies: "restart",
    min: 1,
    max: MAX_OPENAI_ESTIMATED_RSS_GIB,
    help: "이 추정치를 넘기면 워커를 더 늘리지 않습니다. 올릴수록 OOM 위험이 커지며 상한은 오입력 방지용입니다",
  },
  {
    key: "openai.minHostAvailableGiB",
    fallback: "20",
    group: "openai",
    envKey: "QGRID_OPENAI_MIN_HOST_AVAILABLE_GIB",
    label: "호스트 여유 메모리 하한 (GiB)",
    kind: "number",
    applies: "restart",
    min: 0,
    max: MAX_OPENAI_MIN_HOST_AVAILABLE_GIB,
    help: "호스트 여유가 이 값 아래면 스케일업을 멈춥니다. 확장을 끄려면 오토스케일을 끄세요",
  },
  {
    key: "slack.expiryReminderMinutes",
    fallback: "0",
    group: "slack",
    envKey: "SLACK_EXPIRY_REMINDER_INTERVAL_MINUTES",
    label: "만료 알림 반복 주기 (분)",
    kind: "integer",
    applies: "immediate",
    min: 0,
    max: 1440,
    help: "0 이면 반복 알림을 끕니다",
  },
  {
    key: "slack.channelId",
    fallback: "",
    group: "slack",
    envKey: "SLACK_CHANNEL_ID",
    label: "Slack 채널 ID",
    kind: "string",
    applies: "immediate",
    help: "사용자 ID(U...)를 넣으면 그 사람 DM 으로 갑니다",
  },
  {
    key: "slack.userMap",
    fallback: "",
    group: "slack",
    envKey: "SLACK_USER_MAP",
    label: "Slack 사용자 매핑",
    kind: "string",
    applies: "immediate",
    help: "토큰명:SlackUserId 를 쉼표로. 공용 계정은 넣지 않습니다",
  },
  {
    key: "slack.botToken",
    fallback: "",
    group: "slack",
    envKey: "SLACK_BOT_TOKEN",
    label: "Slack 봇 토큰",
    kind: "secret",
    applies: "immediate",
  },
];

export function findSettingDef(key: string): SettingDef | undefined {
  return SETTING_DEFS.find((d) => d.key === key);
}

/** 저장 전 검증. 잘못된 값이 들어가면 런타임에서 조용히 기본값으로 떨어져 원인을 찾기 어렵다. */
export function validateSettingValue(
  def: SettingDef,
  raw: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const trimmed = raw.trim();

  if (def.kind === "boolean") {
    if (!["true", "false"].includes(trimmed)) return { ok: false, error: "true 또는 false" };
    return { ok: true, value: trimmed };
  }

  if (def.kind === "integer" || def.kind === "number") {
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return { ok: false, error: "숫자를 입력하세요" };
    if (def.kind === "integer" && !Number.isInteger(parsed)) {
      return { ok: false, error: "정수를 입력하세요" };
    }
    if (def.min !== undefined && parsed < def.min) {
      return { ok: false, error: `${def.min} 이상이어야 합니다` };
    }
    if (def.max !== undefined && parsed > def.max) {
      return { ok: false, error: `${def.max} 이하여야 합니다` };
    }
    return { ok: true, value: String(parsed) };
  }

  return { ok: true, value: trimmed };
}

/** 화면에 그대로 내려보내면 안 되는 값. 앞뒤만 남긴다. */
export function maskSecret(value: string): string {
  if (value.length <= 12) return "***";
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}
