/**
 * @generated
 * API에서 동기화된 파일입니다. 직접 수정하지 마세요.
 */

import { z } from "zod";

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

// RequestLog - ListParams
// project_name NULL 분기: IS NULL만 조회(unassigned 필터) 또는 IS NOT NULL만(distinct 조회).
export const RequestLogListParams = RequestLogBaseListParams.extend({
  project_name_is_null: z.boolean().optional(),
  project_name_is_not_null: z.boolean().optional(),
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
