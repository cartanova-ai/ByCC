import { z } from "zod";

import { QgridTool } from "../qgrid/qgrid.types";
import { RequestLogBaseListParams, RequestLogBaseSchema } from "../sonamu.generated";

export const HistoryItems = z.array(
  z.object({
    type: z.string(),
    role: z.string().optional(),
    content: z.unknown().optional(),
    name: z.string().optional(),
    arguments: z.string().optional(),
    call_id: z.string().optional(),
    output: z.string().optional(),
  }),
);
export type HistoryItems = z.infer<typeof HistoryItems>;

// 요청에 장착된 tool 정의 목록 — 저장 형태는 QgridTool 계약을 그대로 따른다.
export const ToolDefinitions = z.array(QgridTool);
export type ToolDefinitions = z.infer<typeof ToolDefinitions>;

// request-log detail 화면이 소비하는 tool 계약 projection. API 반환 타입은 Sonamu
// syncer 가 모듈을 해석할 수 있도록 type-only 선언 대신 Zod schema 로 둔다.
export const ToolView = z.object({
  name: z.string(),
  description: z.string().optional(),
  parameterCount: z.number(),
  inputZod: z.string(),
  fullInputZod: z.string().optional(),
});
export type ToolView = z.infer<typeof ToolView>;

// RequestLog - ListParams
// project_name NULL 분기: IS NULL만 조회(unassigned 필터) 또는 IS NOT NULL만(distinct 조회).
export const RequestLogListParams = RequestLogBaseListParams.extend({
  project_name_is_null: z.boolean().optional(),
  project_name_is_not_null: z.boolean().optional(),
  // structured 응답이 깨진(JSON 파싱 실패) 행만 조회
  response_json_broken: z.boolean().optional(),
});
export type RequestLogListParams = z.infer<typeof RequestLogListParams>;

// RequestLog - SaveParams
export const RequestLogSaveParams = RequestLogBaseSchema.partial({
  id: true,
  created_at: true,
  token_name: true,
  status: true,
  error_message: true,
});
export type RequestLogSaveParams = z.infer<typeof RequestLogSaveParams>;
