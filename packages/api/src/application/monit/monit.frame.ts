/**
 * Monit — 대시보드 Monit 탭용 프로세스 로그 관측 API.
 *
 * 읽기 전용. ring buffer 를 얇게 직접 읽으며(범용 쿼리 기계 없이),
 * request log 를 남기지 않는다. 접근 경계는 다른 대시보드 API 와 동일하다.
 */
import { api, BaseFrameClass } from "sonamu";

import { monitLogBuffer } from "./log-buffer";
import { type MonitLogChunk } from "./monit.types";

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
    };
  }
}

export const MonitFrame = new MonitFrameClass();
