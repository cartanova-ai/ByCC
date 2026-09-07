import { isDeepStrictEqual } from "node:util";

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
import { type TokenCredentials, type TokenListParams, type TokenSaveParams } from "./token.types";

const logger = getLogger(["qgrid", "token"]);

const DEFAULT_QUOTA_THRESHOLD = 80;
const DEFAULT_WEIGHT = 1;
const TOKEN_AUTH_DEATH_LOCK_CLASS_ID = 719;

export type TokenUpdateFields = {
  name?: string;
  quota_threshold?: number | null;
  weight?: number;
  keepalive_enabled?: boolean;
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

  async findActiveByProviderAndName<T extends TokenSubsetKey>(
    subset: T,
    provider: string,
    name: string,
  ): Promise<TokenSubsetMapping[T] | undefined> {
    const { qb } = this.getSubsetQueries(subset);
    qb.where("tokens.active", true);
    qb.where("tokens.provider", provider);
    qb.where("tokens.name", name);
    const enhancers = this.createEnhancers({ A: (row) => ({ ...row }) });
    const result = await this.executeSubsetQuery({
      subset,
      qb,
      params: { num: 1, page: 1 },
      enhancers,
      debug: false,
    });
    return result.rows[0];
  }

  /** 실제 인증 만료가 확인돼 재로그인이 필요한 토큰들. 수동 비활성화는 제외한다. */
  async findReauthRequired<T extends TokenSubsetKey>(subset: T): Promise<TokenSubsetMapping[T][]> {
    const { qb } = this.getSubsetQueries(subset);
    qb.where("tokens.reauth_required", true);
    qb.orderBy("tokens.name", "asc");
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

  async toggleActive(id: number): Promise<{ active: boolean; reauthRequired: boolean } | null> {
    const wdb = this.getPuri("w");
    return wdb.transaction(async (trx) => {
      const token = await trx
        .from("tokens")
        .select({ active: "active", reauth_required: "reauth_required" })
        .where("id", id)
        .forUpdate()
        .first();
      if (!token) return null;
      if (!token.active && token.reauth_required) {
        return { active: false, reauthRequired: true };
      }

      const active = !token.active;
      await trx.from("tokens").where("id", id).update({ active });
      return { active, reauthRequired: false };
    });
  }

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
    let keepaliveEnabled = saveParams.keepalive_enabled;
    if (accountId) {
      const oldEntries = await this.findByAccountIdentifier("A", provider, accountId);
      if (keepaliveEnabled === undefined && oldEntries.length > 0) {
        keepaliveEnabled = oldEntries.some((entry) => entry.keepalive_enabled);
      }
      if (oldEntries.length > 0) await this.del(oldEntries.map((o) => o.id));
    } else {
      logger.warn(
        `${provider} login without account identifier: dedup skipped for ${saveParams.name ?? "unnamed"}`,
      );
    }

    await this.save([
      keepaliveEnabled === undefined
        ? saveParams
        : { ...saveParams, keepalive_enabled: keepaliveEnabled },
    ]);
  }

  /**
   * Record confirmed expiry and remove the token from routing atomically.
   * The last active token is also deactivated; its notification is urgent.
   */
  async markReauthRequired(
    id: number,
    expectedCredentials: TokenCredentials,
  ): Promise<{ marked: boolean; wasLastActive: boolean; staleCredentials: boolean }> {
    const wdb = this.getPuri("w");
    return wdb.transaction(async (trx) => {
      const token = await trx
        .from("tokens")
        .select({
          provider: "provider",
          credentials: "credentials",
          reauth_required: "reauth_required",
        })
        .where("id", id)
        .forUpdate()
        .first();
      if (!token || token.reauth_required) {
        return { marked: false, wasLastActive: false, staleCredentials: false };
      }
      if (!isDeepStrictEqual(token.credentials, expectedCredentials)) {
        return { marked: false, wasLastActive: false, staleCredentials: true };
      }

      await trx.knex.raw("SELECT pg_advisory_xact_lock(?, hashtext(?))", [
        TOKEN_AUTH_DEATH_LOCK_CLASS_ID,
        token.provider,
      ]);
      const updated = await trx.knex.raw<{ rows: { was_last_active: boolean }[] }>(
        `WITH previous AS (
           SELECT active AND NOT EXISTS (
             SELECT 1 FROM tokens peer
             WHERE peer.provider = tokens.provider AND peer.active
               AND NOT peer.reauth_required AND peer.id <> tokens.id
           ) AS was_last_active FROM tokens WHERE id = ?
         )
         UPDATE tokens
         SET reauth_required = true,
             active = false
         WHERE id = ? AND reauth_required = false
         RETURNING (SELECT was_last_active FROM previous) AS was_last_active`,
        [id, id],
      );
      const marked = updated.rows[0];
      if (!marked) return { marked: false, wasLastActive: false, staleCredentials: false };

      if (marked.was_last_active) {
        logger.error(`deactivated expired token ${id}: no usable provider tokens remain`);
      }
      return { marked: true, wasLastActive: marked.was_last_active, staleCredentials: false };
    });
  }

  /** Repair rows retained by the former last-active exception before pool reconciliation. */
  async deactivateExpiredTokens(): Promise<void> {
    await this.getPuri("w")
      .table("tokens")
      .where("reauth_required", true)
      .where("active", true)
      .update({ active: false });
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
