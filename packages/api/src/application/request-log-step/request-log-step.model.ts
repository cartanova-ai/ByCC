import {
  BaseModelClass,
  type ListResult,
  asArray,
  NotFoundException,
  BadRequestException,
  api,
  exhaustive,
} from "sonamu";

import { SD } from "../../i18n/sd.generated";
import {
  type RequestLogStepSubsetKey,
  type RequestLogStepSubsetMapping,
} from "../sonamu.generated";
import { requestLogStepSubsetQueries, requestLogStepLoaderQueries } from "../sonamu.generated.sso";
import {
  type RequestLogStepListParams,
  type RequestLogStepSaveParams,
} from "./request-log-step.types";

/*
  RequestLogStep Model
*/
class RequestLogStepModelClass extends BaseModelClass<
  RequestLogStepSubsetKey,
  RequestLogStepSubsetMapping,
  typeof requestLogStepSubsetQueries,
  typeof requestLogStepLoaderQueries
> {
  constructor() {
    super("RequestLogStep", requestLogStepSubsetQueries, requestLogStepLoaderQueries);
  }

  @api({ httpMethod: "GET", clients: ["axios", "tanstack-query"], resourceName: "RequestLogStep" })
  async findById<T extends RequestLogStepSubsetKey>(
    subset: T,
    id: number,
  ): Promise<RequestLogStepSubsetMapping[T]> {
    const { rows } = await this.findMany(subset, {
      id,
      num: 1,
      page: 1,
    });
    if (!rows[0]) {
      throw new NotFoundException(SD("error.entityNotFound")("RequestLogStep", id));
    }

    return rows[0];
  }

  async findOne<T extends RequestLogStepSubsetKey>(
    subset: T,
    listParams: RequestLogStepListParams,
  ): Promise<RequestLogStepSubsetMapping[T] | null> {
    const { rows } = await this.findMany(subset, {
      ...listParams,
      num: 1,
      page: 1,
    });

    return rows[0] ?? null;
  }

  @api({ httpMethod: "GET", clients: ["axios", "tanstack-query"], resourceName: "RequestLogSteps" })
  async findMany<T extends RequestLogStepSubsetKey, LP extends RequestLogStepListParams>(
    subset: T,
    rawParams?: LP,
  ): Promise<ListResult<LP, RequestLogStepSubsetMapping[T]>> {
    // params with defaults
    const params = {
      num: 24,
      page: 1,
      search: "id" as const,
      orderBy: "id-asc" as const,
      ...rawParams,
    } satisfies RequestLogStepListParams;

    // build queries
    const { qb, onSubset: _ } = this.getSubsetQueries(subset);

    if (params.id) {
      qb.whereIn("request_log_steps.id", asArray(params.id));
    }

    if (params.request_log_id) {
      qb.where("request_log_steps.request_log_id", params.request_log_id);
    }

    // search-keyword
    if (params.search && params.keyword && params.keyword.length > 0) {
      if (params.search === "id") {
        qb.where("request_log_steps.id", Number(params.keyword));
        // } else if (params.search === "field") {
        //   qb.where("request_log_steps.field", "like", `%${params.keyword}%`);
      } else {
        throw new BadRequestException(SD("error.unknownSearchField")(params.search));
      }
    }

    // orderBy
    if (params.orderBy) {
      if (params.orderBy === "id-asc") {
        qb.orderBy("request_log_steps.step_index", "asc")
          .orderBy("request_log_steps.tool_call_index", "asc")
          .orderBy("request_log_steps.id", "asc");
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
  async save(spa: RequestLogStepSaveParams[]): Promise<number[]> {
    const wdb = this.getPuri("w");

    // register
    spa.forEach((sp) => {
      wdb.ubRegister("request_log_steps", sp);
    });

    // transaction
    return wdb.transaction(async (trx) => {
      const ids = await trx.ubUpsert("request_log_steps");

      return ids;
    });
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"], guards: ["admin"] })
  async del(ids: number[]): Promise<number> {
    const wdb = this.getPuri("w");

    // transaction
    await wdb.transaction(async (trx) => {
      return trx.table("request_log_steps").whereIn("request_log_steps.id", ids).delete();
    });

    return ids.length;
  }
}

export const RequestLogStepModel = new RequestLogStepModelClass();
