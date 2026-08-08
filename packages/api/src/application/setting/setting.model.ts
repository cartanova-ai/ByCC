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
import { type SettingSubsetKey, type SettingSubsetMapping } from "../sonamu.generated";
import { settingSubsetQueries, settingLoaderQueries } from "../sonamu.generated.sso";
import { findSettingDef, maskSecret, SETTING_DEFS, validateSettingValue } from "./setting.schema";
import {
  getSetting,
  isStored,
  resetSetting as resetStoredSetting,
  saveSetting as saveStoredSetting,
} from "./setting.store";
import {
  type RuntimeInfoItem,
  type SettingApplies,
  type SettingItem,
  type SettingListParams,
  type SettingSaveParams,
  type SettingsResponse,
} from "./setting.types";

/*
  Setting Model
*/
class SettingModelClass extends BaseModelClass<
  SettingSubsetKey,
  SettingSubsetMapping,
  typeof settingSubsetQueries,
  typeof settingLoaderQueries
> {
  constructor() {
    super("Setting", settingSubsetQueries, settingLoaderQueries);
  }

  @api({ httpMethod: "GET", clients: ["axios", "tanstack-query"], resourceName: "Setting" })
  async findById<T extends SettingSubsetKey>(
    subset: T,
    id: number,
  ): Promise<SettingSubsetMapping[T]> {
    const { rows } = await this.findMany(subset, {
      id,
      num: 1,
      page: 1,
    });
    if (!rows[0]) {
      throw new NotFoundException(SD("error.entityNotFound")("Setting", id));
    }

    return rows[0];
  }

  async findOne<T extends SettingSubsetKey>(
    subset: T,
    listParams: SettingListParams,
  ): Promise<SettingSubsetMapping[T] | null> {
    const { rows } = await this.findMany(subset, {
      ...listParams,
      num: 1,
      page: 1,
    });

    return rows[0] ?? null;
  }

  @api({ httpMethod: "GET", clients: ["axios", "tanstack-query"], resourceName: "Settings" })
  async findMany<T extends SettingSubsetKey, LP extends SettingListParams>(
    subset: T,
    rawParams?: LP,
  ): Promise<ListResult<LP, SettingSubsetMapping[T]>> {
    // params with defaults
    const params = {
      num: 24,
      page: 1,
      search: "key" as const,
      orderBy: "key-asc" as const,
      ...rawParams,
    } satisfies SettingListParams;

    // build queries
    const { qb, onSubset: _ } = this.getSubsetQueries(subset);

    // id
    if (params.id) {
      qb.whereIn("settings.id", asArray(params.id));
    }

    // key — toFilter prop 이지만 스캐폴딩이 만들어주지 않아 직접 건다.
    if (params.key) {
      qb.where("settings.key", params.key);
    }

    // search-keyword
    if (params.search && params.keyword && params.keyword.length > 0) {
      if (params.search === "key") {
        qb.where("settings.key", "like", `%${params.keyword}%`);
      } else {
        throw new BadRequestException(SD("error.unknownSearchField")(params.search));
      }
    }

    // orderBy
    if (params.orderBy) {
      // default orderBy
      if (params.orderBy === "key-asc") {
        qb.orderBy("settings.key", "asc");
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

  async save(spa: SettingSaveParams[]): Promise<number[]> {
    const wdb = this.getPuri("w");

    // register
    spa.forEach((sp) => {
      wdb.ubRegister("settings", sp);
    });

    // transaction
    return wdb.transaction(async (trx) => {
      const ids = await trx.ubUpsert("settings");

      return ids;
    });
  }

  async del(ids: number[]): Promise<number> {
    const wdb = this.getPuri("w");

    // transaction
    await wdb.transaction(async (trx) => {
      return trx.table("settings").whereIn("settings.id", ids).delete();
    });

    return ids.length;
  }

  /** 저장된 설정 전체를 key→value 로. 부팅 시 한 번 읽어 메모리에 올린다. */
  async findAllAsMap(): Promise<Map<string, string>> {
    const { rows } = await this.findMany("A", { num: 0, page: 1 });
    return new Map(rows.map((r) => [r.key, r.value]));
  }

  /**
   * key 로 upsert 한다. `save` 는 id 기준이라 key 중복을 걸러내지 못해, 기존 행을 먼저 찾아
   * id 를 실어 보낸다.
   */
  async setByKey(key: string, value: string): Promise<void> {
    const existing = await this.findOne("A", { key, num: 1, page: 1 });
    await this.save([
      {
        ...(existing ? { id: existing.id } : {}),
        key,
        value,
        updated_at: new Date(),
      },
    ]);
  }

  /** 저장값을 지워 env 기본값으로 되돌린다. */
  async clearByKey(key: string): Promise<void> {
    const existing = await this.findOne("A", { key, num: 1, page: 1 });
    if (existing) await this.del([existing.id]);
  }

  /**
   * 편집 가능한 설정과 읽기 전용 런타임 정보. 편집 대상은 `SETTING_DEFS` 에 정의된 것뿐이다 —
   * DB 접속 정보나 포트는 서버가 뜨기 전에 필요해 화면에서 바꿀 수 없다.
   */
  @api({ httpMethod: "GET", clients: ["axios", "tanstack-query"], resourceName: "SettingList" })
  async listSettings(): Promise<SettingsResponse> {
    const settings: SettingItem[] = SETTING_DEFS.map((def) => {
      // 저장값도 env 도 없으면 코드 기본값이 실제로 적용 중이다. 빈칸으로 두면 화면과
      // 런타임이 어긋나 보인다.
      const stored = isStored(def.key);
      const raw = getSetting(def.key, def.envKey);
      const effective = raw ?? def.fallback;
      const source = stored ? "db" : raw !== undefined ? "env" : "default";

      return {
        key: def.key,
        group: def.group,
        label: def.label,
        kind: def.kind,
        applies: def.applies,
        // 눈 토글을 위해 secret 도 원본을 내려보낸다. 이 엔드포인트는 배포 경계에서 인증해야
        // 하며, dev0 는 Caddy 인증을 통과한 운영자만 접근할 수 있다.
        value: effective,
        source,
        min: def.min ?? null,
        max: def.max ?? null,
        help: def.help ?? null,
      };
    });

    return { settings, runtime: this.runtimeInfo() };
  }

  private runtimeInfo(): RuntimeInfoItem[] {
    const env = process.env;
    const password = env.QGRID_DB_PASSWORD ?? env.SONAMU_DB_PASSWORD ?? "";
    return [
      { label: "NODE_ENV", value: env.NODE_ENV ?? "-" },
      { label: "HOST", value: env.HOST ?? "localhost" },
      { label: "PORT", value: env.PORT ?? "44900" },
      { label: "DB Host", value: env.QGRID_DB_HOST ?? env.SONAMU_DB_HOST ?? "-" },
      { label: "DB Port", value: env.QGRID_DB_PORT ?? env.SONAMU_DB_PORT ?? "-" },
      { label: "DB Name", value: env.QGRID_DB_NAME ?? env.SONAMU_DB_NAME ?? "-" },
      { label: "DB User", value: env.QGRID_DB_USER ?? env.SONAMU_DB_USER ?? "-" },
      { label: "DB Password", value: password ? maskSecret(password) : "-" },
    ];
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async updateSetting(key: string, value: string): Promise<{ applies: SettingApplies }> {
    const def = findSettingDef(key);
    if (!def) throw new BadRequestException(SD("setting.unknownKey")(key));

    const validation = validateSettingValue(def, value);
    if (!validation.ok) {
      throw new BadRequestException(SD("setting.invalidValue")(validation.error));
    }

    await saveStoredSetting(key, validation.value);
    return { applies: def.applies };
  }

  /** 저장값을 지워 env 기본값으로 되돌린다. */
  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async resetSetting(key: string): Promise<{ applies: SettingApplies }> {
    const def = findSettingDef(key);
    if (!def) throw new BadRequestException(SD("setting.unknownKey")(key));

    await resetStoredSetting(key);
    return { applies: def.applies };
  }
}

export const SettingModel = new SettingModelClass();
