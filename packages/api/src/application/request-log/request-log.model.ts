import {
  api,
  asArray,
  BadRequestException,
  BaseModelClass,
  exhaustive,
  type ListResult,
  NotFoundException,
} from "sonamu";

import { SD } from "../../i18n/sd.generated";
import { calculateCostUsd } from "../../utils/providers/common/model-cost";
import { type RequestLogSubsetKey, type RequestLogSubsetMapping } from "../sonamu.generated";
import { requestLogLoaderQueries, requestLogSubsetQueries } from "../sonamu.generated.sso";
import { type RequestLogListParams, type RequestLogSaveParams } from "./request-log.types";

// cost_usd는 정수 micro-USD로 저장. 실제 USD = cost_usd / MICRO_USD.
export const MICRO_USD = 1_000_000;

/*
  RequestLog Model
*/
class RequestLogModelClass extends BaseModelClass<
  RequestLogSubsetKey,
  RequestLogSubsetMapping,
  typeof requestLogSubsetQueries,
  typeof requestLogLoaderQueries
> {
  constructor() {
    super("RequestLog", requestLogSubsetQueries, requestLogLoaderQueries);
  }

  @api({ httpMethod: "GET", clients: ["axios", "tanstack-query"], resourceName: "RequestLog" })
  async findById<T extends RequestLogSubsetKey>(
    subset: T,
    id: number,
  ): Promise<RequestLogSubsetMapping[T]> {
    const { rows } = await this.findMany(subset, {
      id,
      num: 1,
      page: 1,
    });
    if (!rows[0]) {
      throw new NotFoundException(SD("error.entityNotFound")("RequestLog", id));
    }

    return rows[0];
  }

  async findOne<T extends RequestLogSubsetKey>(
    subset: T,
    listParams: RequestLogListParams,
  ): Promise<RequestLogSubsetMapping[T] | null> {
    const { rows } = await this.findMany(subset, {
      ...listParams,
      num: 1,
      page: 1,
    });

    return rows[0] ?? null;
  }

  @api({ httpMethod: "GET", clients: ["axios", "tanstack-query"], resourceName: "RequestLogs" })
  async findMany<T extends RequestLogSubsetKey, LP extends RequestLogListParams>(
    subset: T,
    rawParams?: LP,
  ): Promise<ListResult<LP, RequestLogSubsetMapping[T]>> {
    const params = {
      num: 24,
      page: 1,
      search: "id" as const,
      orderBy: "id-desc" as const,
      ...rawParams,
    } satisfies RequestLogListParams;

    const { qb, onSubset: _ } = this.getSubsetQueries(subset);

    if (params.id) {
      qb.whereIn("request_logs.id", asArray(params.id));
    }

    if (params.token_name) {
      qb.where("request_logs.token_name", params.token_name);
    }

    if (params.project_name_is_null) {
      qb.where("request_logs.project_name", null);
    } else if (params.project_name_is_not_null) {
      qb.where("request_logs.project_name", "!=", null);
    } else if (params.project_name) {
      qb.where("request_logs.project_name", params.project_name);
    }

    if (params.model_name) {
      qb.where("request_logs.model_name", params.model_name);
    }

    if (params.search && params.keyword && params.keyword.length > 0) {
      if (params.search === "id") {
        qb.where("request_logs.id", Number(params.keyword));
      } else if (params.search === "token_name") {
        qb.where("request_logs.token_name", "like", `%${params.keyword}%`);
      } else if (params.search === "user_prompt") {
        qb.where("request_logs.user_prompt", "like", `%${params.keyword}%`);
      } else {
        throw new BadRequestException(SD("error.unknownSearchField")(params.search));
      }
    }

    // orderBy
    if (params.orderBy) {
      // default orderBy
      if (params.orderBy === "id-desc") {
        qb.orderBy("request_logs.id", "desc");
      } else {
        exhaustive(params.orderBy);
      }
    }

    const enhancers = this.createEnhancers({
      A: (row) => ({
        ...row,
        // 서브셋별로 virtual 필드 계산로직 추가
      }),
    });

    return this.executeSubsetQuery({
      subset,
      qb,
      params,
      enhancers,
      debug: false,
    });
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async save(spa: RequestLogSaveParams[]): Promise<number[]> {
    const wdb = this.getPuri("w");

    // register
    spa.forEach((sp) => {
      wdb.ubRegister("request_logs", sp);
    });

    // transaction
    return wdb.transaction(async (trx) => {
      const ids = await trx.ubUpsert("request_logs");

      return ids;
    });
  }

  // ── Run Lifecycle ──────────────────────────────────────────────

  async createRun(params: {
    user_prompt: string;
    system_prompt?: string | null;
    model_name?: string | null;
    effort?: string | null;
    project_name?: string | null;
    history?: unknown;
  }): Promise<number> {
    const wdb = this.getPuri("w");
    wdb.ubRegister("request_logs", {
      user_prompt: params.user_prompt,
      system_prompt: params.system_prompt ?? null,
      model_name: params.model_name ?? null,
      effort: params.effort ?? null,
      project_name: params.project_name ?? null,
      status: "running",
      response: "",
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      duration_ms: 0,
      tool_call_count: 0,
      ...(params.history !== undefined
        ? { history: params.history as { type: string }[] }
        : {}),
    });
    return wdb.transaction(async (trx) => {
      const ids = await trx.ubUpsert("request_logs");
      return ids[0]!;
    });
  }

  async appendStep(requestLogId: number, step: Record<string, unknown>): Promise<number> {
    const wdb = this.getPuri("w");
    wdb.ubRegister("request_log_steps", { request_log_id: requestLogId, ...step });
    return wdb.transaction(async (trx) => {
      const ids = await trx.ubUpsert("request_log_steps");
      if (step.type === "tool_call") {
        await trx.from("request_logs").where("id", requestLogId).increment("tool_call_count", 1);
      }
      return ids[0]!;
    });
  }

  async finishRun(
    requestLogId: number,
    params: {
      status: string;
      response?: string;
      token_name?: string;
      input_tokens?: number;
      output_tokens?: number;
      cache_read_tokens?: number;
      cache_creation_tokens?: number;
      duration_ms?: number;
      history?: unknown;
      error_message?: string;
      tool_call_count?: number;
    },
  ): Promise<void> {
    if (params.status === "succeeded" && !params.token_name) {
      throw new Error("tokenName is required for succeeded runs");
    }
    const update: Record<string, unknown> = { id: requestLogId, status: params.status };
    const fields = [
      "response",
      "token_name",
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "cache_creation_tokens",
      "duration_ms",
      "error_message",
      "tool_call_count",
    ] as const;
    for (const key of fields) {
      if (params[key] !== undefined) update[key] = params[key];
    }
    if (params.history !== undefined) update.history = params.history;

    if (params.input_tokens !== undefined && params.output_tokens !== undefined) {
      const db = this.getDB("r");
      const [row] = await db("request_logs")
        .select("model_name")
        .where("id", requestLogId)
        .limit(1);
      if (row?.model_name) {
        const model = row.model_name.includes("/")
          ? row.model_name.split("/").pop()!
          : row.model_name;
        update.cost_usd = Math.round(
          calculateCostUsd(model, {
            inputTokens: params.input_tokens,
            outputTokens: params.output_tokens,
            cachedInputTokens: params.cache_read_tokens ?? 0,
          }) * 1_000_000,
        );
      }
    }

    const wdb = this.getPuri("w");
    wdb.ubRegister("request_logs", update);
    await wdb.transaction(async (trx) => {
      await trx.ubUpsert("request_logs");
    });
  }

  async aggregateStepUsage(requestLogId: number): Promise<{
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    duration_ms: number;
  }> {
    const db = this.getDB("r");
    const [row] = await db("request_log_steps")
      .where("request_log_id", requestLogId)
      .where("type", "generate")
      .sum({
        input_tokens: "input_tokens",
        output_tokens: "output_tokens",
        cache_read_tokens: "cache_read_tokens",
        cache_creation_tokens: "cache_creation_tokens",
        duration_ms: "duration_ms",
      });
    return {
      input_tokens: Number(row?.input_tokens ?? 0),
      output_tokens: Number(row?.output_tokens ?? 0),
      cache_read_tokens: Number(row?.cache_read_tokens ?? 0),
      cache_creation_tokens: Number(row?.cache_creation_tokens ?? 0),
      duration_ms: Number(row?.duration_ms ?? 0),
    };
  }

  async findStaleRunningIds(thresholdMs: number, limit: number = 10): Promise<number[]> {
    const db = this.getDB("r");
    const threshold = new Date(Date.now() - thresholdMs);
    const rows = await db("request_logs")
      .select("id")
      .where("status", "running")
      .where("created_at", "<", threshold)
      .limit(limit);
    return rows.map((r: { id: number }) => r.id);
  }

  async getNextStepIndex(requestLogId: number): Promise<number> {
    const db = this.getDB("r");
    const [row] = await db("request_log_steps")
      .where("request_log_id", requestLogId)
      .max("step_index as maxStep");
    return ((row as { maxStep: number | null })?.maxStep ?? -1) + 1;
  }

  async completeToolCall(
    requestLogId: number,
    toolCallId: string,
    params: { tool_result?: string; tool_duration_ms?: number; error?: string },
  ): Promise<number> {
    const wdb = this.getPuri("w");
    return wdb.transaction(async (trx) => {
      const updated = await trx
        .from("request_log_steps")
        .where("request_log_id", requestLogId)
        .where("tool_call_id", toolCallId)
        .where("type", "tool_call")
        .update({
          ...(params.tool_result !== undefined ? { tool_result: params.tool_result } : {}),
          ...(params.tool_duration_ms !== undefined
            ? { tool_duration_ms: params.tool_duration_ms }
            : {}),
          ...(params.error !== undefined ? { error: params.error } : {}),
        });
      return updated;
    });
  }

  // Sonamu findMany는 subset 전체 컬럼(text 포함)을 페치해서 aggregate엔 너무 무거움 → raw sum 사용.
  async totalCost(params: { token_name?: string } = {}): Promise<number> {
    const qb = this.getDB("r")("request_logs");
    if (params.token_name) {
      qb.where("token_name", params.token_name);
    }
    // knex는 pg에서 numeric aggregate를 string으로 반환.
    const row = (await qb.sum({ sum: "cost_usd" }).first()) as { sum: string | null } | undefined;
    return Number(row?.sum ?? 0) / MICRO_USD;
  }

  async distinctProjectNames(): Promise<string[]> {
    const rows = await this.getPuri("r")
      .from("request_logs")
      .distinct("project_name")
      .where("project_name", "!=", null)
      .orderBy("project_name", "asc")
      .select({
        project_name: "project_name",
      });
    return rows.map((r) => r.project_name!);
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async del(ids: number[]): Promise<number> {
    const wdb = this.getPuri("w");

    // transaction
    await wdb.transaction(async (trx) => {
      await trx
        .table("request_log_steps")
        .whereIn("request_log_steps.request_log_id", ids)
        .delete();
      return trx.table("request_logs").whereIn("request_logs.id", ids).delete();
    });

    return ids.length;
  }
}

export const RequestLogModel = new RequestLogModelClass();
