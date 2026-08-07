import { getLogger } from "@logtape/logtape";
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
import { type TokenSubsetKey, type TokenSubsetMapping } from "../sonamu.generated";
import { tokenLoaderQueries, tokenSubsetQueries } from "../sonamu.generated.sso";
import { type TokenListParams, type TokenSaveParams } from "./token.types";

const logger = getLogger(["qgrid", "token"]);

const DEFAULT_QUOTA_THRESHOLD = 80;
const DEFAULT_WEIGHT = 1;

export type TokenUpdateFields = {
  name?: string;
  quota_threshold?: number | null;
  weight?: number;
};

function applyCreateDefaults(sp: TokenSaveParams): TokenSaveParams {
  if (sp.id !== undefined) return sp;
  return {
    ...sp,
    ...(sp.quota_threshold === undefined ? { quota_threshold: DEFAULT_QUOTA_THRESHOLD } : {}),
    ...(sp.weight === undefined ? { weight: DEFAULT_WEIGHT } : {}),
  };
}

class TokenModelClass extends BaseModelClass<
  TokenSubsetKey,
  TokenSubsetMapping,
  typeof tokenSubsetQueries,
  typeof tokenLoaderQueries
> {
  constructor() {
    super("Token", tokenSubsetQueries, tokenLoaderQueries);
  }

  @api({ httpMethod: "GET", clients: ["axios", "tanstack-query"], resourceName: "Token" })
  async findById<T extends TokenSubsetKey>(subset: T, id: number): Promise<TokenSubsetMapping[T]> {
    const { rows } = await this.findMany(subset, { id, num: 1, page: 1 });
    if (!rows[0]) {
      throw new NotFoundException(SD("error.entityNotFound")("Token", id));
    }
    return rows[0];
  }

  async findOne<T extends TokenSubsetKey>(
    subset: T,
    listParams: TokenListParams,
  ): Promise<TokenSubsetMapping[T] | null> {
    const { rows } = await this.findMany(subset, { ...listParams, num: 1, page: 1 });
    return rows[0] ?? null;
  }

  @api({ httpMethod: "GET", clients: ["axios", "tanstack-query"], resourceName: "Tokens" })
  async findMany<T extends TokenSubsetKey, LP extends TokenListParams>(
    subset: T,
    rawParams?: LP,
  ): Promise<ListResult<LP, TokenSubsetMapping[T]>> {
    const params = {
      num: 24,
      page: 1,
      search: "id" as const,
      orderBy: "ord-asc" as const,
      ...rawParams,
    } satisfies TokenListParams;

    const { qb, onSubset: _ } = this.getSubsetQueries(subset);

    if (params.id) {
      qb.whereIn("tokens.id", asArray(params.id));
    }

    if (params.search && params.keyword && params.keyword.length > 0) {
      if (params.search === "id") {
        qb.where("tokens.id", Number(params.keyword));
      } else if (params.search === "name") {
        qb.where("tokens.name", "like", `%${params.keyword}%`);
      } else {
        throw new BadRequestException(SD("error.unknownSearchField")(params.search));
      }
    }

    if (params.orderBy) {
      if (params.orderBy === "id-desc") {
        qb.orderBy("tokens.id", "desc");
      } else if (params.orderBy === "ord-asc") {
        qb.orderBy("tokens.ord", "asc");
        qb.orderBy("tokens.id", "asc");
      } else {
        exhaustive(params.orderBy);
      }
    }

    const enhancers = this.createEnhancers({
      A: (row) => ({ ...row }),
    });

    return this.executeSubsetQuery({ subset, qb, params, enhancers, debug: false });
  }

  async findByAccountIdentifier<T extends TokenSubsetKey>(
    subset: T,
    provider: string,
    accountId: string,
  ): Promise<TokenSubsetMapping[T][]> {
    const { qb } = this.getSubsetQueries(subset);
    qb.where("tokens.provider", provider);
    const jsonKey = provider === "anthropic" ? "accountUuid" : "accountId";
    qb.whereRaw(`tokens.credentials->>'${jsonKey}' = ?`, [accountId]);
    const enhancers = this.createEnhancers({ A: (row) => ({ ...row }) });
    const result = await this.executeSubsetQuery({
      subset,
      qb,
      params: { num: 100, page: 1 },
      enhancers,
      debug: false,
    });
    return result.rows;
  }

  async findActiveByProvider<T extends TokenSubsetKey>(
    subset: T,
    provider: string,
  ): Promise<TokenSubsetMapping[T][]> {
    const { qb } = this.getSubsetQueries(subset);
    qb.where("tokens.active", true);
    qb.where("tokens.provider", provider);
    const enhancers = this.createEnhancers({ A: (row) => ({ ...row }) });
    const result = await this.executeSubsetQuery({
      subset,
      qb,
      params: { num: 100, page: 1 },
      enhancers,
      debug: false,
    });
    return result.rows;
  }

  async findActive<T extends TokenSubsetKey>(subset: T): Promise<TokenSubsetMapping[T][]> {
    const { qb } = this.getSubsetQueries(subset);
    qb.where("tokens.active", true);
    const enhancers = this.createEnhancers({ A: (row) => ({ ...row }) });
    const result = await this.executeSubsetQuery({
      subset,
      qb,
      params: { num: 100, page: 1 },
      enhancers,
      debug: false,
    });
    return result.rows;
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async save(spa: TokenSaveParams[]): Promise<number[]> {
    const wdb = this.getPuri("w");
    spa.forEach((sp) => {
      wdb.ubRegister("tokens", applyCreateDefaults(sp));
    });
    return wdb.transaction(async (trx) => {
      return trx.ubUpsert("tokens");
    });
  }

  async updateFields(id: number, fields: TokenUpdateFields): Promise<number> {
    const wdb = this.getPuri("w");
    return wdb.transaction((trx) => trx.table("tokens").where("id", id).update(fields));
  }

  /**
   * 세션 만료 토큰을 라우팅에서 제외한다. `active=true` 조건부 갱신이므로 공유 DB 를 쓰는
   * 여러 인스턴스가 동시에 같은 만료를 감지해도 true 를 받는 프로세스는 하나뿐이다
   * (호출부의 알림 발송 게이트).
   *
   * 단, 대상이 해당 provider 의 마지막 활성 토큰이면 갱신하지 않고 false 를 반환한다.
   * client_id 취소나 OAuth 계약 변경처럼 전 토큰이 동시에 실패하는 상황에서 풀이
   * 통째로 비는 것을 막는 안전판이다.
   */
  /**
   * 같은 계정의 기존 토큰을 지우고 새로 저장한다(로그인·재로그인 공통 경로).
   *
   * provider 응답에 계정 식별자가 없으면 dedup 자체가 불가능하므로 경고만 남기고
   * 중복 제거 없이 저장한다(죽은 row 가 남는다).
   */
  async replaceByAccount(
    provider: string,
    accountId: string | undefined,
    saveParams: TokenSaveParams,
  ): Promise<void> {
    if (accountId) {
      const oldEntries = await this.findByAccountIdentifier("A", provider, accountId);
      if (oldEntries.length > 0) await this.del(oldEntries.map((o) => o.id));
    } else {
      logger.warn(
        `${provider} login without account identifier: dedup skipped for ${saveParams.name ?? "unnamed"}`,
      );
    }

    await this.save([saveParams]);
  }

  async deactivateIfActive(id: number): Promise<boolean> {
    const wdb = this.getPuri("w");

    // 활성 여부와 "마지막 남은 토큰인가"를 한 statement 안에서 판정한다. 두 조건을
    // 따로 읽고 나중에 갱신하면 그 사이에 다른 인스턴스가 같은 provider 의 토큰을
    // 비활성화해 풀이 통째로 빌 수 있다.
    const updated = await wdb.knex.raw<{ rowCount: number }>(
      `UPDATE tokens SET active = false
       WHERE id = ? AND active = true
         AND (SELECT count(*) FROM tokens peer
              WHERE peer.provider = tokens.provider AND peer.active) > 1`,
      [id],
    );
    if ((updated.rowCount ?? 0) > 0) return true;

    // 갱신되지 않은 이유는 둘 중 하나다: 이미 비활성이거나(정상 경쟁 결과), 마지막
    // 활성 토큰이거나. 후자는 systemic 실패 신호라 남겨야 하므로 이때만 한 번 더 읽는다.
    const survivor = (
      await wdb.knex.raw<{ rows: { provider: string }[] }>(
        "SELECT provider FROM tokens WHERE id = ? AND active = true",
        [id],
      )
    ).rows[0];
    if (survivor) {
      logger.error(
        `refusing to auto-deactivate token ${id}: last active ${survivor.provider} token — ` +
          `systemic refresh failure suspected, keeping the pool non-empty`,
      );
    }
    return false;
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async reorder(ids: number[]): Promise<{ done: boolean }> {
    const wdb = this.getPuri("w");
    await wdb.transaction(async (trx) => {
      for (let i = 0; i < ids.length; i++) {
        await trx.table("tokens").where("id", ids[i]!).update({ ord: i });
      }
    });
    return { done: true };
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async del(ids: number[]): Promise<number> {
    const wdb = this.getPuri("w");
    await wdb.transaction(async (trx) => {
      return trx.table("tokens").whereIn("tokens.id", ids).delete();
    });
    return ids.length;
  }
}

export const TokenModel = new TokenModelClass();
