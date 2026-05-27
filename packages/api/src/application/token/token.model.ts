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
      wdb.ubRegister("tokens", sp);
    });
    return wdb.transaction(async (trx) => {
      return trx.ubUpsert("tokens");
    });
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
