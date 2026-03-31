/**
 * ByCC Frame — Sonamu HTTP API 엔드포인트.
 *
 * POST   /api/bycc/query       — LLM 쿼리 (system?, prompt)
 * GET    /api/bycc/stats       — 토큰별 사용량
 * POST   /api/bycc/addToken    — 토큰 추가
 * POST   /api/bycc/removeToken — 토큰 제거
 * GET    /api/bycc/health      — 헬스체크
 */
import { api, BaseFrameClass } from "sonamu";
import type { CliResult, HealthResponse, TokenStats } from "./bycc.types";
import { pool } from "./pool.functions";
import { getTokenFilePath, updateTokenInFile } from "./tokens.functions";

class ByccFrameClass extends BaseFrameClass {
  constructor() {
    super("Bycc");
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async query(prompt: string, system?: string, timeout?: number): Promise<CliResult> {
    return pool.query({ system, prompt }, timeout);
  }

  @api({ httpMethod: "GET", clients: ["axios", "tanstack-query"] })
  async stats(): Promise<TokenStats[]> {
    return pool.getStats();
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async addToken(token: string): Promise<{ added: boolean }> {
    pool.addToken(token);
    return { added: true };
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async updateToken(
    token: string,
    name?: string,
    newToken?: string,
  ): Promise<{ updated: boolean }> {
    const entry = updateTokenInFile(token, { name, token: newToken });
    if (!entry) return { updated: false };

    if (newToken) {
      pool.destroyWorkers(token);
      pool.createWorkers(newToken);
    }
    return { updated: true };
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async removeToken(token: string): Promise<{ removed: boolean }> {
    const removed = pool.removeToken(token);
    return { removed };
  }

  @api({ httpMethod: "GET", clients: ["axios", "tanstack-query"] })
  async health(): Promise<HealthResponse> {
    return {
      status: "ok",
      workers: [...pool.workers.values()].flat().length,
      activeTokens: pool.workers.size - pool.quotaExhausted.size,
      tokenDir: getTokenFilePath(),
    };
  }
}

export const ByccFrame = new ByccFrameClass();
