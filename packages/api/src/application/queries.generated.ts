/**
 * @generated
 * 직접 수정하지 마세요.
 */
/** biome-ignore-all lint: generated는 무시 */
/** biome-ignore-all assist: generated는 무시 */

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

export namespace ByccService {
  export const stats = (): SSRQuery => createSSRQuery("ByccFrame", "stats", [], ["Bycc", "stats"]);

  export const health = (): SSRQuery =>
    createSSRQuery("ByccFrame", "health", [], ["Bycc", "health"]);
}
