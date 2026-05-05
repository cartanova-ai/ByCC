/**
 * @generated
 * 직접 수정하지 마세요.
 */

import { type PuriWrapper, type DatabaseSchemaExtend, type PuriLoaderQueries } from "sonamu";

import {
  type RequestLogSubsetKey,
  type TokenSubsetKey,
  type RequestLogBaseSchema,
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
      user_prompt: "request_logs.user_prompt",
      system_prompt: "request_logs.system_prompt",
      response: "request_logs.response",
      input_tokens: "request_logs.input_tokens",
      output_tokens: "request_logs.output_tokens",
      cache_read_tokens: "request_logs.cache_read_tokens",
      cache_creation_tokens: "request_logs.cache_creation_tokens",
      duration_ms: "request_logs.duration_ms",
      cost_usd: "request_logs.cost_usd",
    });
  },
  P: (qbWrapper: PuriWrapper<DatabaseSchemaExtend>) => {
    return qbWrapper.from("request_logs").select({
      id: "request_logs.id",
      created_at: "request_logs.created_at",
      token_name: "request_logs.token_name",
      project_name: "request_logs.project_name",
      model_name: "request_logs.model_name",
      input_tokens: "request_logs.input_tokens",
      output_tokens: "request_logs.output_tokens",
      cache_read_tokens: "request_logs.cache_read_tokens",
      cache_creation_tokens: "request_logs.cache_creation_tokens",
      duration_ms: "request_logs.duration_ms",
      cost_usd: "request_logs.cost_usd",
    });
  },
};

// LoaderQuery: RequestLog
export const requestLogLoaderQueries = {
  A: [],
  P: [],
} as const satisfies PuriLoaderQueries<RequestLogSubsetKey>;

// SubsetQuery: Token
export const tokenSubsetQueries = {
  A: (qbWrapper: PuriWrapper<DatabaseSchemaExtend>) => {
    return qbWrapper.from("tokens").select({
      id: "tokens.id",
      created_at: "tokens.created_at",
      token: "tokens.token",
      name: "tokens.name",
      refresh_token: "tokens.refresh_token",
      expires_at: "tokens.expires_at",
      account_uuid: "tokens.account_uuid",
      active: "tokens.active",
      ord: "tokens.ord",
    });
  },
};

// LoaderQuery: Token
export const tokenLoaderQueries = {
  A: [],
} as const satisfies PuriLoaderQueries<TokenSubsetKey>;

// DatabaseSchema
declare module "sonamu" {
  export interface DatabaseSchemaExtend {
    request_logs: RequestLogBaseSchema;
    tokens: TokenBaseSchema;
  }

  export interface DatabaseForeignKeys {}
}
