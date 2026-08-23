/**
 * @generated
 * API에서 동기화된 파일입니다. 직접 수정하지 마세요.
 */

import { z } from "zod";

import { SettingBaseSchema, SettingBaseListParams } from "../sonamu.generated";

// Setting - ListParams
export const SettingListParams = SettingBaseListParams;
export type SettingListParams = z.infer<typeof SettingListParams>;

// Setting - SaveParams
export const SettingSaveParams = SettingBaseSchema.partial({ id: true, created_at: true });
export type SettingSaveParams = z.infer<typeof SettingSaveParams>;

// ── 설정 API 응답 스키마 ──

export const SettingKind = z.enum(["boolean", "integer", "number", "string", "secret", "preset"]);
export type SettingKind = z.infer<typeof SettingKind>;

export const SettingApplies = z.enum(["immediate", "restart"]);
export type SettingApplies = z.infer<typeof SettingApplies>;

export const SettingSource = z.enum(["db", "env", "default"]);
export type SettingSource = z.infer<typeof SettingSource>;

/**
 * 프로세스를 다시 띄워주는 도구. 재시작은 스스로 종료하고 이 도구에 맡기므로,
 * 없으면(null) 화면에서 재시작을 시도조차 하지 않는다.
 *
 * API 반환 타입에 쓰이므로 zod 로 둔다 — sonamu syncer 가 클라이언트 코드를 만들 때
 * 타입만 있는 선언은 모듈을 찾지 못한다.
 */
export const SupervisorKind = z.enum(["pm2"]);
export type SupervisorKind = z.infer<typeof SupervisorKind>;

export const SettingItem = z.object({
  key: z.string(),
  group: z.string(),
  label: z.string(),
  kind: SettingKind,
  applies: SettingApplies,
  /** 현재 적용 중인 값. 눈 토글을 지원하기 위해 secret 도 원본으로 내려간다. */
  value: z.string(),
  /** 이 값이 어디서 왔는지. 화면에서 출처를 보여줘야 "왜 안 바뀌지"가 없다. */
  source: SettingSource,
  min: z.number().nullable(),
  max: z.number().nullable(),
  /** `preset` 종류에서 고를 수 있는 값. 다른 종류는 빈 배열. */
  presets: z.number().array(),
  help: z.string().nullable(),
});
export type SettingItem = z.infer<typeof SettingItem>;

/** 화면에서 바꿀 수 없는 기동 시점 값들 — 어떤 환경에 붙어 있는지 확인용. */
export const RuntimeInfoItem = z.object({
  label: z.string(),
  value: z.string(),
});
export type RuntimeInfoItem = z.infer<typeof RuntimeInfoItem>;

export const SettingsResponse = z.object({
  settings: SettingItem.array(),
  runtime: RuntimeInfoItem.array(),
  /** null 이면 재시작 버튼을 쓸 수 없다 — 종료해도 되살릴 주체가 없다. */
  supervisor: SupervisorKind.nullable(),
  /** 이 인스턴스가 keepalive 스케줄러를 소유하도록 명시적으로 허용됐는지. */
  keepaliveRunnerEnabled: z.boolean(),
});
export type SettingsResponse = z.infer<typeof SettingsResponse>;
