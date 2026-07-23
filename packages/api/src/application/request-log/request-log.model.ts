import {
  api,
  asArray,
  BadRequestException,
  BaseModelClass,
  exhaustive,
  type ListResult,
  NotFoundException,
  Puri,
  transactional,
} from "sonamu";

import { SD } from "../../i18n/sd.generated";
import { calculateCostUsd } from "../../utils/providers/common/model-cost";
import { type RequestLogSubsetKey, type RequestLogSubsetMapping } from "../sonamu.generated";
import { requestLogLoaderQueries, requestLogSubsetQueries } from "../sonamu.generated.sso";
import { type RequestLogListParams, type RequestLogSaveParams } from "./request-log.types";

// cost_usd는 정수 micro-USD로 저장. 실제 USD = cost_usd / MICRO_USD.
export const MICRO_USD = 1_000_000;
const REQUEST_LOG_RUN_LOCK_CLASS_ID = 718;

type ToolResultContinuation = {
  toolCallId: string;
  output: string;
  isError?: boolean;
};

type RequestLogStepAggregate = {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cache_creation_5m_tokens?: number;
  cache_creation_1h_tokens?: number;
  duration_ms: number;
  fallback_count: number;
  cost_usd: number;
  cost_source?: string;
};

const STEP_AGGREGATE_SELECT = {
  input_tokens: "input_tokens",
  output_tokens: "output_tokens",
  cache_read_tokens: "cache_read_tokens",
  cache_creation_tokens: "cache_creation_tokens",
  cache_creation_5m_tokens: "cache_creation_5m_tokens",
  cache_creation_1h_tokens: "cache_creation_1h_tokens",
  duration_ms: "duration_ms",
  fallback_count: "fallback_count",
  cost_usd: "cost_usd",
  cost_source: "cost_source",
} as const;

function aggregateGenerateStepRows(rows: Array<Record<string, unknown>>): RequestLogStepAggregate {
  const sum = (field: string): number =>
    rows.reduce((total, row) => total + Number(row[field] ?? 0), 0);
  const optionalSum = (field: string): number | undefined =>
    rows.some((row) => row[field] !== null && row[field] !== undefined) ? sum(field) : undefined;
  const collapse = (field: string): string | undefined => {
    const values = [
      ...new Set(
        rows
          .map((row) => row[field])
          .filter((value): value is string => typeof value === "string" && value.length > 0),
      ),
    ];
    if (values.length === 0) return undefined;
    return values.length === 1 ? values[0] : "mixed";
  };
  return {
    input_tokens: sum("input_tokens"),
    output_tokens: sum("output_tokens"),
    cache_read_tokens: sum("cache_read_tokens"),
    cache_creation_tokens: sum("cache_creation_tokens"),
    cache_creation_5m_tokens: optionalSum("cache_creation_5m_tokens"),
    cache_creation_1h_tokens: optionalSum("cache_creation_1h_tokens"),
    duration_ms: sum("duration_ms"),
    fallback_count: sum("fallback_count"),
    cost_usd: sum("cost_usd"),
    cost_source: collapse("cost_source"),
  };
}

type RequestLogUsageRow = {
  token_name?: string | null;
  model_name?: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cache_creation_5m_tokens?: number | null;
  cache_creation_1h_tokens?: number | null;
  cost_usd?: number | null;
  cost_source?: string | null;
};

function isAnthropicUsageRow(row: Pick<RequestLogUsageRow, "token_name" | "model_name">): boolean {
  return (
    row.token_name?.startsWith("anthropic/") === true ||
    row.model_name?.startsWith("claude-") === true ||
    row.model_name?.startsWith("anthropic/claude-") === true
  );
}

function canonicalModelName(modelName: string): string {
  return modelName.includes("/") ? modelName.split("/").pop()! : modelName;
}

function normalizedUsageForCost(row: RequestLogUsageRow): {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  cacheCreationInputTokens5m?: number;
  cacheCreationInputTokens1h?: number;
} {
  const cacheRead = row.cache_read_tokens;
  const cacheCreation = row.cache_creation_tokens;
  const storedInput = row.input_tokens;
  const legacyAnthropicSplitInput =
    isAnthropicUsageRow(row) && storedInput < cacheRead + cacheCreation;
  return {
    model: row.model_name ? canonicalModelName(row.model_name) : null,
    inputTokens: legacyAnthropicSplitInput ? storedInput + cacheRead + cacheCreation : storedInput,
    outputTokens: row.output_tokens,
    cachedInputTokens: cacheRead,
    cacheCreationInputTokens: cacheCreation,
    ...(row.cache_creation_5m_tokens !== null && row.cache_creation_5m_tokens !== undefined
      ? { cacheCreationInputTokens5m: row.cache_creation_5m_tokens }
      : {}),
    ...(row.cache_creation_1h_tokens !== null && row.cache_creation_1h_tokens !== undefined
      ? { cacheCreationInputTokens1h: row.cache_creation_1h_tokens }
      : {}),
  };
}

function normalizeLegacyAnthropicRow<T extends RequestLogUsageRow>(row: T): T {
  // 새 row 는 당시의 provider/가격표 비용을 확정 저장한다. 현재 가격표로 덮어쓰지 않는다.
  if (row.cost_source) return row;
  const usage = normalizedUsageForCost(row);
  if (usage.inputTokens === row.input_tokens) return row;
  const normalized = { ...row, input_tokens: usage.inputTokens };
  if (usage.model) {
    normalized.cost_usd = Math.round(calculateCostUsd(usage.model, usage) * MICRO_USD);
  }
  return normalized;
}

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
      A: (row) => normalizeLegacyAnthropicRow(row),
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
    requested_model_name?: string | null;
    effort?: string | null;
    project_name?: string | null;
    history?: unknown;
    is_image_generation?: boolean;
  }): Promise<number> {
    const wdb = this.getPuri("w");
    wdb.ubRegister("request_logs", {
      user_prompt: params.user_prompt,
      system_prompt: params.system_prompt ?? null,
      // provider 실행 전이므로 serving model은 아직 알 수 없다.
      requested_model_name: params.requested_model_name ?? null,
      model_name: null,
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
      // 이미지 turn 식별(R13). run 경로(tools+image 조합)도 auto 경로와 동일하게 마킹.
      is_image_generation: params.is_image_generation ?? false,
      ...(params.history !== undefined ? { history: params.history as { type: string }[] } : {}),
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
      cache_creation_5m_tokens?: number | null;
      cache_creation_1h_tokens?: number | null;
      duration_ms?: number;
      requested_model_name?: string | null;
      model_name?: string | null;
      fallback_count?: number | null;
      cost_usd?: number | null;
      cost_source?: string | null;
      history?: unknown;
      error_message?: string;
      tool_call_count?: number;
      image_cost_usd?: number | null;
      image_cost_method?: string | null;
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
      "cache_creation_5m_tokens",
      "cache_creation_1h_tokens",
      "duration_ms",
      "requested_model_name",
      "model_name",
      "fallback_count",
      "cost_usd",
      "cost_source",
      "error_message",
      "tool_call_count",
      "image_cost_usd",
      "image_cost_method",
    ] as const;
    for (const key of fields) {
      if (params[key] !== undefined) update[key] = params[key];
    }
    if (params.history !== undefined) update.history = params.history;
    update.ttft_ms = (await this.firstGenerateStepTtft(requestLogId)) ?? 0;

    // 서버 run 경로는 step 에서 확정한 exact cost 를 넘긴다. 외부/legacy caller 가 비용을
    // 생략한 경우에만 저장된 모델+usage 로 계산한다.
    if (
      params.cost_usd === undefined &&
      params.input_tokens !== undefined &&
      params.output_tokens !== undefined
    ) {
      const row = await this.getPuri("r")
        .from("request_logs")
        .select({ model_name: "model_name" })
        .where("id", requestLogId)
        .first();
      const effectiveModelName = params.model_name ?? row?.model_name;
      if (effectiveModelName) {
        const model = canonicalModelName(effectiveModelName);
        const usage = normalizedUsageForCost({
          token_name: params.token_name,
          model_name: effectiveModelName,
          input_tokens: params.input_tokens,
          output_tokens: params.output_tokens,
          cache_read_tokens: params.cache_read_tokens ?? 0,
          cache_creation_tokens: params.cache_creation_tokens ?? 0,
          cache_creation_5m_tokens: params.cache_creation_5m_tokens,
          cache_creation_1h_tokens: params.cache_creation_1h_tokens,
        });
        update.cost_usd = Math.round(
          calculateCostUsd(model, {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cachedInputTokens: usage.cachedInputTokens,
            cacheCreationInputTokens: usage.cacheCreationInputTokens,
            cacheCreationInputTokens5m: usage.cacheCreationInputTokens5m,
            cacheCreationInputTokens1h: usage.cacheCreationInputTokens1h,
          }) * 1_000_000,
        );
        update.cost_source = "pricing_table";
      }
    }

    const wdb = this.getPuri("w");
    wdb.ubRegister("request_logs", update);
    await wdb.transaction(async (trx) => {
      await trx.ubUpsert("request_logs");
    });
  }

  async firstGenerateStepTtft(requestLogId: number): Promise<number | null> {
    const row = await this.getPuri("r")
      .from("request_log_steps")
      .select({ ttft_ms: "ttft_ms" })
      .where("request_log_id", requestLogId)
      .where("type", "generate")
      .where("ttft_ms", "!=", null)
      .orderBy("step_index", "asc")
      .orderBy("id", "asc")
      .first();
    return row?.ttft_ms === null || row?.ttft_ms === undefined ? null : Number(row.ttft_ms);
  }

  async aggregateStepUsage(requestLogId: number): Promise<RequestLogStepAggregate> {
    const rows = await this.getPuri("r")
      .from("request_log_steps")
      .select(STEP_AGGREGATE_SELECT)
      .where("request_log_id", requestLogId)
      .where("type", "generate");
    return aggregateGenerateStepRows(rows as Array<Record<string, unknown>>);
  }

  /**
   * Finds stale candidates, then expires each run in its own short transaction.
   * The candidate query is only a hint; the transactional operation rechecks it
   * after acquiring the advisory lock shared with tool follow-ups.
   */
  async expireStaleToolWaitingRuns(
    thresholdMs: number,
    errorMessage: string,
    limit: number = 10,
  ): Promise<number[]> {
    const threshold = new Date(Date.now() - thresholdMs);
    const candidateIds = await this.findStaleToolWaitingRunCandidates(threshold, limit);
    const expiredIds: number[] = [];
    for (const requestLogId of candidateIds) {
      if (await this.tryExpireStaleToolWaitingRun(requestLogId, threshold, errorMessage)) {
        expiredIds.push(requestLogId);
      }
    }
    return expiredIds;
  }

  async findStaleToolWaitingRunCandidates(threshold: Date, limit: number): Promise<number[]> {
    const rows = await this.getPuri("w")
      .from("request_logs")
      .join("request_log_steps", "request_logs.id", "request_log_steps.request_log_id")
      .distinct("request_logs.id")
      .select({ id: "request_logs.id" })
      .where("request_logs.status", "running")
      .where("request_log_steps.type", "tool_call")
      .where("request_log_steps.created_at", "<", threshold)
      .where("request_log_steps.tool_result", null)
      .where("request_log_steps.error", null)
      .limit(limit);
    return rows.map(({ id }) => id);
  }

  @transactional({ dbPreset: "w" })
  async tryExpireStaleToolWaitingRun(
    requestLogId: number,
    threshold: Date,
    errorMessage: string,
  ): Promise<boolean> {
    const wdb = this.getPuri("w");
    const lockResult = (await wdb.knex.raw("SELECT pg_try_advisory_xact_lock(?, ?) AS acquired", [
      REQUEST_LOG_RUN_LOCK_CLASS_ID,
      requestLogId,
    ])) as { rows?: Array<{ acquired?: boolean }> };
    if (lockResult.rows?.[0]?.acquired !== true) return false;

    // The follow-up path uses the same writer transaction lock. Recheck after
    // locking so a result committed during candidate discovery makes this a no-op.
    const unresolved = await wdb
      .from("request_log_steps")
      .select({ id: "id" })
      .where("request_log_id", requestLogId)
      .where("type", "tool_call")
      .where("created_at", "<", threshold)
      .where("tool_result", null)
      .where("error", null)
      .first();
    if (!unresolved) return false;

    const stepRows = await wdb
      .from("request_log_steps")
      .select(STEP_AGGREGATE_SELECT)
      .where("request_log_id", requestLogId)
      .where("type", "generate");
    const aggregate = aggregateGenerateStepRows(stepRows as Array<Record<string, unknown>>);
    const firstTtft = await wdb
      .from("request_log_steps")
      .select({ ttft_ms: "ttft_ms" })
      .where("request_log_id", requestLogId)
      .where("type", "generate")
      .where("ttft_ms", "!=", null)
      .orderBy("step_index", "asc")
      .orderBy("id", "asc")
      .first();

    const updated = await wdb
      .from("request_logs")
      .where("id", requestLogId)
      .where("status", "running")
      .update({
        status: "error",
        error_message: errorMessage,
        input_tokens: aggregate.input_tokens,
        output_tokens: aggregate.output_tokens,
        cache_read_tokens: aggregate.cache_read_tokens,
        cache_creation_tokens: aggregate.cache_creation_tokens,
        ...(aggregate.cache_creation_5m_tokens !== undefined
          ? { cache_creation_5m_tokens: aggregate.cache_creation_5m_tokens }
          : {}),
        ...(aggregate.cache_creation_1h_tokens !== undefined
          ? { cache_creation_1h_tokens: aggregate.cache_creation_1h_tokens }
          : {}),
        duration_ms: aggregate.duration_ms,
        fallback_count: aggregate.fallback_count,
        cost_usd: aggregate.cost_usd,
        ...(aggregate.cost_source !== undefined ? { cost_source: aggregate.cost_source } : {}),
        ttft_ms:
          firstTtft?.ttft_ms === null || firstTtft?.ttft_ms === undefined
            ? 0
            : Number(firstTtft.ttft_ms),
      });
    return updated > 0;
  }

  /**
   * Applies a native qgrid tool follow-up and computes its next step index while
   * holding the per-run advisory lock shared with stale cleanup.
   */
  @transactional({ dbPreset: "w" })
  async continueToolRun(
    requestLogId: number,
    toolResults: ToolResultContinuation[],
  ): Promise<number> {
    const wdb = this.getPuri("w");
    await wdb.knex.raw("SELECT pg_advisory_xact_lock(?, ?)", [
      REQUEST_LOG_RUN_LOCK_CLASS_ID,
      requestLogId,
    ]);

    const run = await wdb
      .from("request_logs")
      .select({ status: "status" })
      .where("id", requestLogId)
      .first();
    if (!run) throw new Error(`request log run ${requestLogId} not found`);
    if (run.status !== "running") {
      throw new Error(`request log run ${requestLogId} is already ${run.status}`);
    }

    for (const result of toolResults) {
      await wdb
        .from("request_log_steps")
        .where("request_log_id", requestLogId)
        .where("tool_call_id", result.toolCallId)
        .where("type", "tool_call")
        .update(result.isError ? { error: result.output } : { tool_result: result.output });
    }

    const row = await wdb
      .from("request_log_steps")
      .select({ max_step: Puri.max("step_index") })
      .where("request_log_id", requestLogId)
      .first();
    return (row?.max_step ?? -1) + 1;
  }

  // Sonamu findMany는 subset 전체 컬럼(text 포함)을 페치하므로 비용 계산에 필요한 컬럼만 조회한다.
  async totalCost(params: { token_name?: string } = {}): Promise<number> {
    // 기존 cost_usd 에는 과거 Anthropic cache 계산 버그로 음수가 저장된 row 가 있을 수 있다.
    // 화면 집계는 저장값 sum 이 아니라 현재 계산식으로 usage 를 재계산해 과거 로그도 즉시 보정한다.
    const rows = await this.getPuri("r")
      .from("request_logs")
      .where(params.token_name ? { token_name: params.token_name } : {})
      .select({
        model_name: "model_name",
        input_tokens: "input_tokens",
        output_tokens: "output_tokens",
        cache_read_tokens: "cache_read_tokens",
        cache_creation_tokens: "cache_creation_tokens",
        cache_creation_5m_tokens: "cache_creation_5m_tokens",
        cache_creation_1h_tokens: "cache_creation_1h_tokens",
        cost_usd: "cost_usd",
        cost_source: "cost_source",
      });

    return rows.reduce((sum, row) => {
      // cost_source 가 있으면 새 계약으로 확정 저장된 값이다. 프로모션/가격 변경 이후에도
      // 당시 비용을 유지한다. NULL인 legacy row 만 현재 가격표로 보정한다.
      if (row.cost_source && row.cost_usd !== null) {
        return sum + Math.max(row.cost_usd, 0) / MICRO_USD;
      }
      const usage = normalizedUsageForCost(row);
      if (!usage.model) return sum + Math.max(row.cost_usd ?? 0, 0) / MICRO_USD;
      return (
        sum +
        calculateCostUsd(usage.model, {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cachedInputTokens: usage.cachedInputTokens,
          cacheCreationInputTokens: usage.cacheCreationInputTokens,
          cacheCreationInputTokens5m: usage.cacheCreationInputTokens5m,
          cacheCreationInputTokens1h: usage.cacheCreationInputTokens1h,
        })
      );
    }, 0);
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
