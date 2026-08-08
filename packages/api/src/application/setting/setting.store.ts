/**
 * 런타임 설정 조회 캐시.
 *
 * 값의 출처는 DB(`settings`) → env 순이다. env 를 남겨두는 이유는 전환 때문이다 — dev0 는
 * `ecosystem.config.json` 으로 값을 주입하는데, DB 만 보게 만들면 배포 직후 설정이 전부
 * 기본값으로 떨어진다.
 *
 * 설정은 요청 경로(워커 스케일링, 알림 전송)에서 읽히므로 매번 DB 를 때리지 않고 메모리에
 * 둔다. 인스턴스가 여러 개면 다른 인스턴스의 캐시는 즉시 갱신되지 않는다 — 설정 변경이
 * 잦지 않고, 워커 설정은 어차피 재시작 후 반영이라 감수한다.
 */
import { getLogger } from "@logtape/logtape";

import { SettingModel } from "./setting.model";

const logger = getLogger(["qgrid", "setting"]);

/** 로드 전에는 null 이라 전부 env 로 떨어진다. */
let cache: Map<string, string> | null = null;

export async function loadSettings(): Promise<void> {
  try {
    cache = await SettingModel.findAllAsMap();
    logger.info(`settings loaded: ${cache.size} stored`);
  } catch (e) {
    // 테이블이 아직 없는 배포(마이그레이션 전)에서도 서버는 떠야 한다.
    cache = new Map();
    logger.warn(`settings load failed, using env only: ${(e as Error).message}`);
  }
}

/** DB → env 순. 둘 다 없으면 undefined 라 호출부의 기본값으로 떨어진다. */
export function getSetting(key: string, envKey: string): string | undefined {
  return cache?.get(key) ?? process.env[envKey];
}

/** 저장된 값인지 — 화면에서 출처를 구분해 보여준다. */
export function isStored(key: string): boolean {
  return cache?.has(key) ?? false;
}

export async function saveSetting(key: string, value: string): Promise<void> {
  await SettingModel.setByKey(key, value);
  cache ??= new Map();
  cache.set(key, value);
}

/** 저장값을 지워 env 기본값으로 되돌린다. */
export async function resetSetting(key: string): Promise<void> {
  await SettingModel.clearByKey(key);
  cache?.delete(key);
}
