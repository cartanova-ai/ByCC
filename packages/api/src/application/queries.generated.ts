/**
 * @generated
 * 직접 수정하지 마세요.
 */

/* oxlint-disable */

import type { SSRQuery } from "sonamu/ssr";

// SSRQuery 헬퍼 함수
function createSSRQuery(
  modelName: string,
  methodName: string,
  params: any[],
  serviceKey: [string, string],
): SSRQuery {
  return { modelName, methodName, params, serviceKey, __brand: "SSRQuery" } as SSRQuery;
}

import { RequestLogStepListParams } from "./request-log-step/request-log-step.types";
import { RequestLogListParams } from "./request-log/request-log.types";
import { TokenSubsetKey, RequestLogStepSubsetKey, RequestLogSubsetKey } from "./sonamu.generated";
import { TokenListParams } from "./token/token.types";

export namespace TokenService {
  export const getToken = <T extends TokenSubsetKey>(subset: T, id: number): SSRQuery =>
    createSSRQuery("TokenModel", "findById", [subset, id], ["Token", "getToken"]);

  export const getTokens = <T extends TokenSubsetKey, LP extends TokenListParams>(
    subset: T,
    rawParams?: LP,
  ): SSRQuery =>
    createSSRQuery("TokenModel", "findMany", [subset, rawParams], ["Token", "getTokens"]);
}

export namespace RequestLogStepService {
  export const getRequestLogStep = <T extends RequestLogStepSubsetKey>(
    subset: T,
    id: number,
  ): SSRQuery =>
    createSSRQuery(
      "RequestLogStepModel",
      "findById",
      [subset, id],
      ["RequestLogStep", "getRequestLogStep"],
    );

  export const getRequestLogSteps = <
    T extends RequestLogStepSubsetKey,
    LP extends RequestLogStepListParams,
  >(
    subset: T,
    rawParams?: LP,
  ): SSRQuery =>
    createSSRQuery(
      "RequestLogStepModel",
      "findMany",
      [subset, rawParams],
      ["RequestLogStep", "getRequestLogSteps"],
    );
}

export namespace RequestLogService {
  export const getRequestLog = <T extends RequestLogSubsetKey>(subset: T, id: number): SSRQuery =>
    createSSRQuery("RequestLogModel", "findById", [subset, id], ["RequestLog", "getRequestLog"]);

  export const getRequestLogs = <T extends RequestLogSubsetKey, LP extends RequestLogListParams>(
    subset: T,
    rawParams?: LP,
  ): SSRQuery =>
    createSSRQuery(
      "RequestLogModel",
      "findMany",
      [subset, rawParams],
      ["RequestLog", "getRequestLogs"],
    );
}

export namespace QgridService {
  export const stats = (): SSRQuery =>
    createSSRQuery("QgridFrame", "stats", [], ["Qgrid", "stats"]);

  export const totalCost = (params?: RequestLogListParams): SSRQuery =>
    createSSRQuery("QgridFrame", "totalCost", [params], ["Qgrid", "totalCost"]);

  export const projectNames = (): SSRQuery =>
    createSSRQuery("QgridFrame", "projectNames", [], ["Qgrid", "projectNames"]);

  export const usage = (tokenId?: number): SSRQuery =>
    createSSRQuery("QgridFrame", "usage", [tokenId], ["Qgrid", "usage"]);

  export const health = (): SSRQuery =>
    createSSRQuery("QgridFrame", "health", [], ["Qgrid", "health"]);
}

export namespace MonitService {
  export const monitLogs = (cursor?: number): SSRQuery =>
    createSSRQuery("MonitFrame", "monitLogs", [cursor], ["Monit", "monitLogs"]);

  export const monitInfo = (): SSRQuery =>
    createSSRQuery("MonitFrame", "monitInfo", [], ["Monit", "monitInfo"]);
}
