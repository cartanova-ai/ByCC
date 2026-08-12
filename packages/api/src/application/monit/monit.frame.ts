/**
 * Monit — 대시보드 Monit 탭용 프로세스 로그 관측 API.
 *
 * 읽기 전용. ring buffer 를 얇게 직접 읽으며(범용 쿼리 기계 없이),
 * request log 를 남기지 않는다. 접근 경계는 다른 대시보드 API 와 동일하다.
 */
import { api, BaseFrameClass, DB } from "sonamu";

import { resolveOpenAIPermitConfig } from "../../utils/providers/openai/openai-permit-config";
import { QgridDispatcher } from "../qgrid/qgrid.dispatcher";
import { monitLogBuffer } from "./log-buffer";
import { type MonitLogChunk, type MonitServerInfo, type MonitVitals } from "./monit.types";

// 응답당 엔트리 상한 — 폴링 클라이언트는 다음 폴에서 이어서 따라잡는다.
const RESPONSE_ENTRY_LIMIT = 1_000;

class MonitFrameClass extends BaseFrameClass {
  constructor() {
    super("Monit");
  }

  @api({ httpMethod: "GET", clients: ["axios", "tanstack-query"] })
  async monitLogs(cursor?: number): Promise<MonitLogChunk> {
    return {
      processStartedAt: monitLogBuffer.processStartedAt,
      ...monitLogBuffer.after(cursor, RESPONSE_ENTRY_LIMIT),
      vitals: currentVitals(),
    };
  }

  // 프로세스 정적 정보 — 폴링 불필요, 페이지당 1회 조회.
  @api({ httpMethod: "GET", clients: ["axios", "tanstack-query"] })
  async monitInfo(): Promise<MonitServerInfo> {
    const permits = resolveOpenAIPermitConfig();
    const host = process.env.HOST ?? "localhost";
    const port = process.env.PORT ?? "44900";
    const conn = activeDbConnection();
    return {
      serverUrl: `http://${host}:${port}`,
      dbHost: conn.host ?? "localhost",
      dbName: conn.database ?? "qgrid",
      openai: {
        minWorkersPerToken: permits.permitsPerToken,
        maxWorkersPerToken: permits.permitsPerToken,
        autoscale: false,
      },
    };
  }
}

// dispatcher 미초기화(부팅 직후) 시 0 으로 응답한다 — 가벼운 스냅샷이라 오류로 만들지 않는다.
function currentVitals(): MonitVitals {
  return {
    openaiWorkerCount: QgridDispatcher.openaiDispatcher?.workerCount ?? 0,
    openaiReadyWorkerCount: QgridDispatcher.openaiDispatcher?.readyWorkerCount ?? 0,
    openaiQueueLength: QgridDispatcher.openaiDispatcher?.queueLength ?? 0,
    openaiWorkersByToken: QgridDispatcher.openaiDispatcher?.workerCountsByToken ?? [],
    anthropicTokenCount: QgridDispatcher.anthropicDispatcher?.tokenCount ?? 0,
    anthropicTokenNames: QgridDispatcher.anthropicDispatcher?.tokenNames ?? [],
  };
}

// 실제 활성 knex 연결에서 읽는다 — dev 서버의 통합 테스트 러너가 process.env.SONAMU_DB_NAME 을
// 테스트 DB 이름으로 덮어쓰므로 env 는 신뢰할 수 없다. DB 미초기화(부팅 전) 시에만 env 폴백.
function activeDbConnection(): { host?: string; database?: string } {
  try {
    const connection = DB.getDBConfig("w").connection;
    if (typeof connection === "object" && connection !== null) {
      return connection as { host?: string; database?: string };
    }
  } catch {
    // DB config 미초기화 — env 폴백으로 진행
  }
  return { host: process.env.SONAMU_DB_HOST, database: process.env.SONAMU_DB_NAME };
}

export const MonitFrame = new MonitFrameClass();
