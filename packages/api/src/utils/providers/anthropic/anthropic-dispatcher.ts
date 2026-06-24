/**
 * AnthropicDispatcher
 *
 * OpenAIDispatcher와 달리, worker pool을 두는 대신 요청별 fresh spawn
 * 토큰은 인메모리(MAP)으로 관리하고 least-used, round-robin 으로 고른다
 *
 * - 모든 요청은 fresh `--session-id` 로 실행
 * - 멀티턴 문맥은 클라이언트가 매 호출 보내는 full history 를 평탄화해 전달한다.
 * - 발급한 session-id 를 GenerateResult.threadCoord(threadId=session-id, workerId=tokenId,
 *   epoch=0)로 올려, 상위(issueConvContext)가 클라에 회송할 좌표를 만든다. 다음 turn 이 좌표를
 *   회송해도 Anthropic 라우팅에는 쓰지 않는다.
 */

import { getLogger } from "@logtape/logtape";

import { TokenModel } from "../../../application/token/token.model";
import { type AnthropicCredentials } from "../../../application/token/token.types";
import { getExpiresAt, getRefreshToken } from "../common/credentials";
import {
  type GenerateRequest,
  type GenerateResult,
  type GenerateStreamCallbacks,
  type ProviderDispatcher,
} from "../common/provider-dispatcher";
import { assertSupportedOneMillionSuffix, canonicalAnthropicModel } from "./anthropic-constants";
import { makeAnthropicWorkerId, runClaudeSession } from "./claude-session";

const logger = getLogger(["qgrid", "anthropic-dispatcher"]);

// 1M context 정상 생성은 실측상 100s+까지 간다. 240s는 완충 장치일 뿐,
// 거부+거대 system 재생성 지연을 완전히 해결하는 값은 아니다.
const DEFAULT_TIMEOUT_MS = 240_000;
// access token 만료 임박 임계 — 기존 standalone 경로(qgrid.dispatcher.ts)와 동일(60s).
const REFRESH_SAFETY_MS = 60_000;

interface PooledToken {
  id: number;
  name: string;
  credentials: AnthropicCredentials;
}

export class AnthropicDispatcher implements ProviderDispatcher {
  // tokenId → 풀 항목. start()/token 이벤트로 채움
  private tokenPool = new Map<number, PooledToken>();
  // tokenId 별 사용 카운터(least-used RR). name 이 아니라 id 기준 — 이름 충돌 안전
  private requestCounts = new Map<number, number>();
  private rrIndex = 0;

  async start(): Promise<void> {
    // OpenAIDispatcher.start() 와 동일하게 DB 에서 기존 anthropic 토큰을 self-bootstrap 한다.
    // (서버 재시작 시 NOTIFY 가 안 오므로 부트스트랩이 없으면 풀이 빈 채로 남는다.)
    // 이후 변경분은 token-subscriber 가 onTokenAdded/Updated/Removed 로 전달한다.
    // findActiveByProvider 가 active=true + provider 필터를 DB 에서 처리 → inactive 는 애초에 안 온다.
    const tokens = await TokenModel.findActiveByProvider("A", "anthropic");
    for (const t of tokens) {
      this.tokenPool.set(t.id, {
        id: t.id,
        name: t.name,
        credentials: t.credentials as AnthropicCredentials,
      });
      logger.info(`worker spawned: ${t.name}`);
    }
  }

  async stop(): Promise<void> {
    this.tokenPool.clear();
    // lifecycle 정합: RR 카운터/인덱스도 비워 stop→start 재등록 시 이전 카운트가 안 남게 한다.
    this.requestCounts.clear();
    this.rrIndex = 0;
  }

  // 현재 풀의 토큰 수(startup 로그/health 용).
  get tokenCount(): number {
    return this.tokenPool.size;
  }

  // DB active anthropic 토큰 목록으로 풀을 재동기화한다(periodic reconcile/재연결용).
  // LISTEN/NOTIFY 가 끊긴 동안 유실된 추가/삭제/비활성화를 DB 기준으로 다시 맞춘다.
  // 이벤트 핸들러를 재사용해 풀 갱신이 일관되게 적용되도록 한다:
  //  - DB 에 없는데 풀에 있는 토큰 → onTokenRemoved
  //  - DB 에 있는 토큰 → 신규면 onTokenAdded, 기존이면 onTokenUpdated
  replaceTokens(
    rows: Array<{ id: number; name: string; credentials: AnthropicCredentials }>,
  ): void {
    const next = new Set(rows.map((r) => r.id));
    // onTokenRemoved 가 tokenPool 을 delete 하므로 순회 중 수정을 피하려 키를 먼저 스냅샷한다.
    const currentIds = Array.from(this.tokenPool.keys());
    for (const id of currentIds) {
      if (!next.has(id)) this.onTokenRemoved(id);
    }
    for (const r of rows) {
      if (this.tokenPool.has(r.id)) this.onTokenUpdated(r.id, r.name, r.credentials);
      else this.onTokenAdded(r.id, r.name, r.credentials);
    }
  }

  // token events (token-subscriber 가 호출)
  onTokenAdded(id: number, name: string, credentials: AnthropicCredentials): void {
    this.tokenPool.set(id, { id, name, credentials });
  }

  onTokenUpdated(id: number, name: string, credentials: AnthropicCredentials): void {
    this.tokenPool.set(id, { id, name, credentials });
  }

  onTokenRemoved(id: number): void {
    this.tokenPool.delete(id);
    this.requestCounts.delete(id);
  }

  private countOf(id: number): number {
    return this.requestCounts.get(id) ?? 0;
  }

  // 요청마다 least-used RR 로 토큰을 고른다(동점이면 rrIndex 로 회전).
  private selectToken(): PooledToken | null {
    const rows = [...this.tokenPool.values()];
    if (rows.length === 0) return null;
    const minCount = Math.min(...rows.map((r) => this.countOf(r.id)));
    const idle = rows.filter((r) => this.countOf(r.id) === minCount);
    const picked = idle[this.rrIndex % idle.length]!;
    this.rrIndex++;
    return this.charge(picked);
  }

  // 선택된 토큰의 사용 카운트를 await 전에 선반영(동시 요청이 다른 토큰을 고르도록).
  private charge(token: PooledToken): PooledToken {
    this.requestCounts.set(token.id, this.countOf(token.id) + 1);
    return token;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    return this.run(req, () => {});
  }

  async generateStream(req: GenerateRequest, cb: GenerateStreamCallbacks): Promise<void> {
    try {
      const result = await this.run(req, cb.onDelta, { includePartialMessages: true });
      cb.onThreadId?.(result.threadCoord.threadId);
      cb.onComplete(result);
    } catch (e) {
      cb.onError(e as Error);
    }
  }

  // generate/generateStream 공통 실행. onDelta 는 스트림이면 점진 방출, 비스트림이면 no-op.
  private async run(
    req: GenerateRequest,
    onDelta: (t: string) => void,
    opts?: { includePartialMessages?: boolean },
  ): Promise<GenerateResult> {
    // model 정규화를 dispatcher 진입점에서 한 번 한다: result.model / runClaudeSession 전부
    // canonical(prefix 없는 cost 키) 을 쓰게 통일. 미지정이면 ANTHROPIC_DEFAULT_MODEL — qgrid.dispatcher
    // 의 "sonnet" 별칭 우회 차단. 정규화 규칙은 fallback 경로와 공유(canonicalAnthropicModel).
    assertSupportedOneMillionSuffix(req.model);
    const model = canonicalAnthropicModel(req.model);
    const jsonSchema =
      req.outputSchema !== undefined ? JSON.stringify(req.outputSchema) : undefined;

    const token = this.selectToken();
    if (!token) throw new Error("No anthropic tokens available");

    const exec = async (): Promise<GenerateResult> => {
      // 만료 임박 토큰 preemptive refresh(기존 standalone 경로와 동일). 실패해도 진행.
      let accessToken = token.credentials.accessToken;
      const expiresAt = getExpiresAt(token.credentials);
      if (
        expiresAt &&
        expiresAt - Date.now() < REFRESH_SAFETY_MS &&
        getRefreshToken(token.credentials)
      ) {
        try {
          const { QgridFrame } = await import("../../../application/qgrid/qgrid.frame");
          // provider 를 반드시 채워야 refreshToken 내부 TokenModel.save 가 성공한다.
          // refreshToken(TokenSubsetA) 는 id/provider/credentials/name 만 사용하므로 그 4개만 넘긴다.
          accessToken = await QgridFrame.refreshToken({
            id: token.id,
            provider: "anthropic",
            name: token.name,
            credentials: token.credentials,
          } as Parameters<typeof QgridFrame.refreshToken>[0]);
        } catch (e) {
          logger.warn(`refresh failed for ${token.name}: ${(e as Error).message}`);
        }
      }

      logger.info(`→ ${token.name} (model: ${model})`);
      const session = await runClaudeSession(
        {
          tokenId: token.id,
          token: accessToken,
          model,
          system: req.systemPrompt,
          jsonSchema,
          effort: req.effort,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          coldHistory: req.coldHistory,
          input: req.coldInput,
          abortSignal: req.abortSignal,
          includePartialMessages: opts?.includePartialMessages,
        },
        onDelta,
      );

      if (session.quotaExhausted) throw new Error(`quota exhausted (${token.name})`);
      if (session.isError) {
        // text 가 비어 있을 수 있으므로 진단 가능한 형태로 메시지를 만든다(subtype 등은 raw 로그 참조).
        const detail = session.text || `empty text, outputTokens=${session.usage.outputTokens}`;
        throw new Error(`claude error (${token.name}): ${detail}`);
      }

      return {
        text: session.text,
        tokenName: token.name,
        usage: session.usage,
        durationMs: session.durationMs,
        costUsd: session.costUsd,
        model,
        // systemHash 는 상위 issueConvContext 가 채운다(여기선 비운다).
        threadCoord: {
          workerId: makeAnthropicWorkerId(token.id),
          threadId: session.sessionId,
          epoch: 0,
        },
      };
    };

    return exec();
  }
}
