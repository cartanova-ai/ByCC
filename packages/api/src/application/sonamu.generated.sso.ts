/**
 * @generated
 * 직접 수정하지 마세요.
 */

import { type PuriWrapper, type DatabaseSchemaExtend, type PuriLoaderQueries } from "sonamu";

import {
  type RequestLogSubsetKey,
  type RequestLogStepSubsetKey,
  type SettingSubsetKey,
  type TokenSubsetKey,
  type RequestLogBaseSchema,
  type RequestLogStepBaseSchema,
  type SettingBaseSchema,
  type TokenBaseSchema,
} from "./sonamu.generated";

// SubsetQuery: RequestLog
export const requestLogSubsetQueries = {
  A: (qbWrapper: PuriWrapper<DatabaseSchemaExtend>) => {
    return qbWrapper.from("request_logs").select({
      id: "request_logs.id",
      created_at: "request_logs.created_at",
      token_name: "request_logs.token_name",
      project_name: "request_logs.project_name",
      model_name: "request_logs.model_name",
      requested_model_name: "request_logs.requested_model_name",
      fallback_count: "request_logs.fallback_count",
      user_prompt: "request_logs.user_prompt",
      system_prompt: "request_logs.system_prompt",
      response: "request_logs.response",
      input_tokens: "request_logs.input_tokens",
      output_tokens: "request_logs.output_tokens",
      cache_read_tokens: "request_logs.cache_read_tokens",
      cache_creation_tokens: "request_logs.cache_creation_tokens",
      cache_creation_5m_tokens: "request_logs.cache_creation_5m_tokens",
      cache_creation_1h_tokens: "request_logs.cache_creation_1h_tokens",
      duration_ms: "request_logs.duration_ms",
      ttft_ms: "request_logs.ttft_ms",
      cost_usd: "request_logs.cost_usd",
      cost_source: "request_logs.cost_source",
      image_cost_usd: "request_logs.image_cost_usd",
      image_cost_method: "request_logs.image_cost_method",
      effort: "request_logs.effort",
      history: "request_logs.history",
      tools: "request_logs.tools",
      status: "request_logs.status",
      response_json_ok: "request_logs.response_json_ok",
      error_message: "request_logs.error_message",
      tool_call_count: "request_logs.tool_call_count",
      is_image_generation: "request_logs.is_image_generation",
      is_structured: "request_logs.is_structured",
    });
  },
  P: (qbWrapper: PuriWrapper<DatabaseSchemaExtend>) => {
    return qbWrapper.from("request_logs").select({
      id: "request_logs.id",
      created_at: "request_logs.created_at",
      token_name: "request_logs.token_name",
      project_name: "request_logs.project_name",
      model_name: "request_logs.model_name",
      requested_model_name: "request_logs.requested_model_name",
      fallback_count: "request_logs.fallback_count",
      input_tokens: "request_logs.input_tokens",
      output_tokens: "request_logs.output_tokens",
      cache_read_tokens: "request_logs.cache_read_tokens",
      cache_creation_tokens: "request_logs.cache_creation_tokens",
      cache_creation_5m_tokens: "request_logs.cache_creation_5m_tokens",
      cache_creation_1h_tokens: "request_logs.cache_creation_1h_tokens",
      duration_ms: "request_logs.duration_ms",
      ttft_ms: "request_logs.ttft_ms",
      cost_usd: "request_logs.cost_usd",
      cost_source: "request_logs.cost_source",
      image_cost_usd: "request_logs.image_cost_usd",
      image_cost_method: "request_logs.image_cost_method",
      effort: "request_logs.effort",
      status: "request_logs.status",
      response_json_ok: "request_logs.response_json_ok",
      tool_call_count: "request_logs.tool_call_count",
      is_image_generation: "request_logs.is_image_generation",
      is_structured: "request_logs.is_structured",
    });
  },
  C: (qbWrapper: PuriWrapper<DatabaseSchemaExtend>) => {
    return qbWrapper.from("request_logs").select({
      id: "request_logs.id",
      token_name: "request_logs.token_name",
      model_name: "request_logs.model_name",
      input_tokens: "request_logs.input_tokens",
      output_tokens: "request_logs.output_tokens",
      cache_read_tokens: "request_logs.cache_read_tokens",
      cache_creation_tokens: "request_logs.cache_creation_tokens",
      cache_creation_5m_tokens: "request_logs.cache_creation_5m_tokens",
      cache_creation_1h_tokens: "request_logs.cache_creation_1h_tokens",
      cost_usd: "request_logs.cost_usd",
      cost_source: "request_logs.cost_source",
    });
  },
};

// LoaderQuery: RequestLog
export const requestLogLoaderQueries = {
  A: [],
  P: [],
  C: [],
} as const satisfies PuriLoaderQueries<RequestLogSubsetKey>;

// SubsetQuery: RequestLogStep
export const requestLogStepSubsetQueries = {
  A: (qbWrapper: PuriWrapper<DatabaseSchemaExtend>) => {
    return qbWrapper.from("request_log_steps").select({
      id: "request_log_steps.id",
      created_at: "request_log_steps.created_at",
      step_index: "request_log_steps.step_index",
      type: "request_log_steps.type",
      model_name: "request_log_steps.model_name",
      requested_model_name: "request_log_steps.requested_model_name",
      fallback_count: "request_log_steps.fallback_count",
      input_tokens: "request_log_steps.input_tokens",
      output_tokens: "request_log_steps.output_tokens",
      cache_read_tokens: "request_log_steps.cache_read_tokens",
      cache_creation_tokens: "request_log_steps.cache_creation_tokens",
      cache_creation_5m_tokens: "request_log_steps.cache_creation_5m_tokens",
      cache_creation_1h_tokens: "request_log_steps.cache_creation_1h_tokens",
      cost_usd: "request_log_steps.cost_usd",
      cost_source: "request_log_steps.cost_source",
      duration_ms: "request_log_steps.duration_ms",
      ttft_ms: "request_log_steps.ttft_ms",
      finish_reason: "request_log_steps.finish_reason",
      reasoning_text: "request_log_steps.reasoning_text",
      reasoning_tokens: "request_log_steps.reasoning_tokens",
      tool_call_index: "request_log_steps.tool_call_index",
      tool_call_id: "request_log_steps.tool_call_id",
      tool_name: "request_log_steps.tool_name",
      tool_args: "request_log_steps.tool_args",
      tool_result: "request_log_steps.tool_result",
      tool_duration_ms: "request_log_steps.tool_duration_ms",
      error: "request_log_steps.error",
    });
  },
  T: (qbWrapper: PuriWrapper<DatabaseSchemaExtend>) => {
    return qbWrapper.from("request_log_steps").select({
      id: "request_log_steps.id",
      created_at: "request_log_steps.created_at",
      step_index: "request_log_steps.step_index",
      type: "request_log_steps.type",
      model_name: "request_log_steps.model_name",
      requested_model_name: "request_log_steps.requested_model_name",
      fallback_count: "request_log_steps.fallback_count",
      input_tokens: "request_log_steps.input_tokens",
      output_tokens: "request_log_steps.output_tokens",
      cache_read_tokens: "request_log_steps.cache_read_tokens",
      cache_creation_tokens: "request_log_steps.cache_creation_tokens",
      cache_creation_5m_tokens: "request_log_steps.cache_creation_5m_tokens",
      cache_creation_1h_tokens: "request_log_steps.cache_creation_1h_tokens",
      cost_usd: "request_log_steps.cost_usd",
      cost_source: "request_log_steps.cost_source",
      duration_ms: "request_log_steps.duration_ms",
      ttft_ms: "request_log_steps.ttft_ms",
      finish_reason: "request_log_steps.finish_reason",
      reasoning_tokens: "request_log_steps.reasoning_tokens",
      tool_call_index: "request_log_steps.tool_call_index",
      tool_call_id: "request_log_steps.tool_call_id",
      tool_name: "request_log_steps.tool_name",
      tool_duration_ms: "request_log_steps.tool_duration_ms",
      error: "request_log_steps.error",
    });
  },
  I: (qbWrapper: PuriWrapper<DatabaseSchemaExtend>) => {
    return qbWrapper.from("request_log_steps").select({
      id: "request_log_steps.id",
      tool_args: "request_log_steps.tool_args",
    });
  },
};

// LoaderQuery: RequestLogStep
export const requestLogStepLoaderQueries = {
  A: [],
  T: [],
  I: [],
} as const satisfies PuriLoaderQueries<RequestLogStepSubsetKey>;

// SubsetQuery: Setting
export const settingSubsetQueries = {
  A: (qbWrapper: PuriWrapper<DatabaseSchemaExtend>) => {
    return qbWrapper.from("settings").select({
      id: "settings.id",
      created_at: "settings.created_at",
      key: "settings.key",
      value: "settings.value",
      updated_at: "settings.updated_at",
    });
  },
};

// LoaderQuery: Setting
export const settingLoaderQueries = {
  A: [],
} as const satisfies PuriLoaderQueries<SettingSubsetKey>;

// SubsetQuery: Token
export const tokenSubsetQueries = {
  A: (qbWrapper: PuriWrapper<DatabaseSchemaExtend>) => {
    return qbWrapper.from("tokens").select({
      id: "tokens.id",
      created_at: "tokens.created_at",
      provider: "tokens.provider",
      credentials: "tokens.credentials",
      name: "tokens.name",
      active: "tokens.active",
      ord: "tokens.ord",
      quota_threshold: "tokens.quota_threshold",
      weight: "tokens.weight",
    });
  },
};

// LoaderQuery: Token
export const tokenLoaderQueries = {
  A: [],
} as const satisfies PuriLoaderQueries<TokenSubsetKey>;

// ForeignKey Types
export type RequestLogStepForeignKeys = "request_log_id";

// DatabaseSchema
declare module "sonamu" {
  export interface DatabaseSchemaExtend {
    request_logs: RequestLogBaseSchema;
    request_log_steps: RequestLogStepBaseSchema;
    settings: SettingBaseSchema;
    tokens: TokenBaseSchema;
  }

  export interface DatabaseForeignKeys {
    request_log_steps: RequestLogStepForeignKeys;
  }
}
