import { type z } from "zod";

import { RequestLogStepBaseSchema, RequestLogStepBaseListParams } from "../sonamu.generated";

// RequestLogStep - ListParams
export const RequestLogStepListParams = RequestLogStepBaseListParams;
export type RequestLogStepListParams = z.infer<typeof RequestLogStepListParams>;

// RequestLogStep - SaveParams
export const RequestLogStepSaveParams = RequestLogStepBaseSchema.partial({
  id: true,
  created_at: true,
  request_log_id: true,
  input_tokens: true,
  output_tokens: true,
  cache_read_tokens: true,
  cache_creation_tokens: true,
  duration_ms: true,
  finish_reason: true,
  tool_call_index: true,
  tool_call_id: true,
  tool_name: true,
  tool_args: true,
  tool_result: true,
  tool_duration_ms: true,
  error: true,
});
export type RequestLogStepSaveParams = z.infer<typeof RequestLogStepSaveParams>;
