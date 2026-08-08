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

export const SettingKind = z.enum(["boolean", "integer", "number", "string", "secret"]);
export type SettingKind = z.infer<typeof SettingKind>;

export const SettingApplies = z.enum(["immediate", "restart"]);
export type SettingApplies = z.infer<typeof SettingApplies>;

export const SettingSource = z.enum(["db", "env", "default"]);
export type SettingSource = z.infer<typeof SettingSource>;

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
});
export type SettingsResponse = z.infer<typeof SettingsResponse>;
