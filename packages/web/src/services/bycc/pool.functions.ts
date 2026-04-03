/**
 * @generated
 * API에서 동기화된 파일입니다. 직접 수정하지 마세요.
 */
/**
 * ClaudePool — 멀티 토큰 프로세스 풀.
 *
 * 2-layer 아키텍처: ClaudePool → Worker (flat)
 * - Map<token, Worker[]>로 토큰별 워커 관리 (원본 토큰이 키)
 * - least-queue-depth 라우팅
 * - 투명한 쿼터 failover (QuotaError 시 다른 토큰으로 자동 재시도)
 * - 토큰 파일(data/bycc-tokens.json) 영속성까지 책임
 */
import type { CliResult, PoolConfig, QueryInput, TokenStats } from "./bycc.types";
import { QuotaError } from "./bycc.types";
import { getQuotaStatus, recordUsage } from "./quota.functions";
import { addTokenToFile, loadTokens, removeTokenFromFile } from "./tokens.functions";
import { Worker, type WorkerConfig } from "./worker.functions";

class ClaudePool {
  workers = new Map<string, Worker[]>();
  quotaExhausted = new Set<string>();
  requestCounts = new Map<string, number>();
  size: number;
  model: string;
  timeout: number;
  cwd: string;
  maxCalls: number;

  constructor(config: PoolConfig) {
    this.size = config.size ?? 3;
    this.model = config.model ?? "sonnet";
    this.timeout = config.timeout ?? 300_000;
    this.cwd = config.cwd ?? "/tmp/bycc";
    this.maxCalls = config.maxCalls ?? 500;

    config.tokens.forEach((token) => {
      this.createWorkers(token);
    });
  }

  addToken(token: string, name?: string): void {
    addTokenToFile(token, name);
    this.createWorkers(token);
  }

  removeToken(token: string): boolean {
    if (!this.workers.has(token)) return false;

    removeTokenFromFile(token);
    this.destroyWorkers(token);
    return true;
  }

  getStats(): TokenStats[] {
    const entries = loadTokens();
    return [...this.workers.keys()].map((token) => ({
      token,
      name: entries.find((e) => e.token === token)?.name,
      requests: this.requestCounts.get(token) ?? 0,
      active: !this.quotaExhausted.has(token),
      quota: getQuotaStatus(token),
    }));
  }

  selectWorker(): Worker | null {
    const candidates = [...this.workers.entries()]
      .filter(([token]) => !this.quotaExhausted.has(token))
      .flatMap(([, workers]) => workers);

    if (candidates.length === 0) return null;

    return candidates.reduce((best, w) => (w.getQueueDepth() < best.getQueueDepth() ? w : best));
  }

  async query(input: QueryInput, timeoutMs?: number): Promise<CliResult> {
    const triedTokens = new Set<string>();

    while (true) {
      const worker = this.selectWorker();
      if (!worker) {
        throw new QuotaError("All tokens exhausted");
      }

      if (triedTokens.has(worker.tokenId)) {
        throw new QuotaError("All tokens exhausted");
      }

      try {
        const result = await worker.query(input, timeoutMs);
        this.requestCounts.set(worker.tokenId, (this.requestCounts.get(worker.tokenId) ?? 0) + 1);

        // best-effort: usage 기록 실패해도 쿼리 결과는 반환
        try {
          recordUsage(
            worker.tokenId,
            result.usage.input_tokens,
            result.usage.output_tokens,
            result.costUsd,
          );
        } catch (e) {
          console.error("recordUsage failed:", e);
        }

        return result;
      } catch (err) {
        if (err instanceof QuotaError) {
          this.quotaExhausted.add(worker.tokenId);
          triedTokens.add(worker.tokenId);
          continue;
        }
        throw err;
      }
    }
  }

  kill(): void {
    [...this.workers.values()].flat().forEach((w) => {
      w.kill();
    });
  }

  createWorkers(token: string): void {
    if (this.workers.has(token)) return;

    const workerConfig: WorkerConfig = {
      token,
      model: this.model,
      timeout: this.timeout,
      cwd: this.cwd,
      maxCalls: this.maxCalls,
    };

    const workers = Array.from({ length: this.size }, () => new Worker(workerConfig));
    this.workers.set(token, workers);
    this.requestCounts.set(token, 0);
  }

  destroyWorkers(token: string): void {
    const workers = this.workers.get(token);
    if (!workers) return;

    workers.forEach((w) => {
      w.kill();
    });
    this.workers.delete(token);
    this.quotaExhausted.delete(token);
    this.requestCounts.delete(token);
  }
}

// 파일에서 인증토큰 로드
const entries = loadTokens();
const tokens = entries.filter((e) => e.active).map((e) => e.token);
export const pool = new ClaudePool({ tokens });
