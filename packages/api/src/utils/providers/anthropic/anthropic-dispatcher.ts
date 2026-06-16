/**
 * AnthropicDispatcher — Claude(Anthropic) provider 의 ProviderDispatcher 구현.
 *
 * OpenAIDispatcher 패턴을 미러링하되, worker pool 대신 요청별 fresh spawn(U4 runClaudeSession)을
 * 쓴다. 토큰은 자체 풀(Map)로 관리하고 least-used round-robin 으로 고른다.
 *
 * 멀티턴 / 동시성 계약 (codex U1 2차 리뷰 반영 — 현재 구현 기준):
 *  - **eligibility 는 compatibilityKey(system+model+schema)** 로 판정한다. systemHash 가 아니다.
 *    GenerateRequest.reuse 가 들어오면 그 threadId(=claude session-id)에 대해 dispatcher-local
 *    `sessionCompat` 에 저장해 둔 호환키와 이번 요청 호환키를 비교 — 일치 시 resume, 불일치/없음 시
 *    cold(새 session-id). (P1-5)
 *  - **compat 는 threadCoord 로 왕복하지 않는다.** sessionCompat 는 이 dispatcher 인스턴스 메모리에만
 *    산다(TTL sweep + 토큰 제거 시 정리). threadCoord.systemHash 는 상위 issueConvContext 가 따로
 *    채우지만 Anthropic resume eligibility 판정에는 쓰이지 않는다(codex P1-4 정정).
 *  - **락 범위**: resume(같은 claude session-id 로 이어지는 turn)만 `withSessionLock` 으로 직렬화해
 *    transcript 오염을 막는다. cold 는 매번 새 random session-id 라 충돌이 없어 락을 걸지 않는다.
 *    "동시 첫 호출" 경쟁을 따로 막지 않는 근거는 run() 의 락 주석 참조(IF/owner scope 의 순차 호출 전제).
 *  - 발급한 session-id 와 호환키를 GenerateResult.threadCoord(threadId=session-id, workerId=tokenId,
 *    epoch=0)로 올려, 상위(issueConvContext)가 클라에 회송할 좌표를 만든다.
 */

import { getLogger } from "@logtape/logtape";

import { type AnthropicCredentials } from "../../../application/token/token.types";
import { getExpiresAt, getRefreshToken } from "../common/credentials";
import {
  type GenerateRequest,
  type GenerateResult,
  type GenerateStreamCallbacks,
  type ProviderDispatcher,
} from "../common/provider-dispatcher";
import { ANTHROPIC_DEFAULT_MODEL } from "./anthropic-constants";
import {
  compatibilityKey,
  makeAnthropicWorkerId,
  runClaudeSession,
  withSessionLock,
} from "./claude-session";

const logger = getLogger(["qgrid", "anthropic-dispatcher"]);

const DEFAULT_TIMEOUT_MS = 120_000;
// access token 만료 임박 임계 — 기존 standalone 경로(qgrid.dispatcher.ts)와 동일(60s).
const REFRESH_SAFETY_MS = 60_000;

interface PooledToken {
  id: number;
  name: string;
  credentials: AnthropicCredentials;
}

// QgridFrame.refreshToken 은 TokenSubsetA(특히 provider)를 받아 TokenModel.save 에 넘긴다.
// anthropic 풀의 토큰은 항상 provider="anthropic" 이므로 refresh 시 이 값을 고정으로 채운다.
// (codex P1: provider 누락 → save 실패 → 만료 access token 으로 진행하는 버그 방지)
const ANTHROPIC_PROVIDER = "anthropic" as const;

// session-id → compat 매핑 TTL. 서버 thread idle TTL(10분)과 정합 — 그보다 오래된 세션은
// 어차피 resume 불가하므로 폐기해도 안전. (codex P1: sessionCompat 무한 증가 방지)
const SESSION_COMPAT_TTL_MS = 10 * 60 * 1000;

interface CompatEntry {
  compat: string;
  tokenId: number;
  lastUsedAt: number;
}

export class AnthropicDispatcher implements ProviderDispatcher {
  // tokenId → 풀 항목. start()/token 이벤트로 채운다.
  private tokenPool = new Map<number, PooledToken>();
  // tokenId 별 사용 카운터(least-used RR). name 이 아니라 id 기준 — 이름 충돌 안전(codex P2).
  private requestCounts = new Map<number, number>();
  private rrIndex = 0;
  // claude session-id → 그 세션을 만든 요청의 호환키(+tokenId/lastUsedAt). resume eligibility 판정.
  // TTL sweep + 토큰 제거 시 정리로 무한 증가 방지(codex P1).
  private sessionCompat = new Map<string, CompatEntry>();

  // ── lifecycle ──────────────────────────────────────────────────

  async start(): Promise<void> {
    // 토큰은 token-subscriber(U5)가 onTokenAdded 로 채운다. 여기선 검증만.
    logger.info(`anthropic dispatcher started (${this.tokenPool.size} tokens)`);
  }

  async stop(): Promise<void> {
    this.tokenPool.clear();
    this.sessionCompat.clear();
    // lifecycle 정합: RR 카운터/인덱스도 비워 stop→start 재등록 시 이전 카운트가 안 남게 한다(codex P2).
    this.requestCounts.clear();
    this.rrIndex = 0;
  }

  // ── token events (token-subscriber 가 호출) ──────────────────────

  onTokenAdded(id: number, name: string, credentials: AnthropicCredentials): void {
    this.tokenPool.set(id, { id, name, credentials });
  }
  onTokenUpdated(id: number, name: string, credentials: AnthropicCredentials): void {
    // access/refresh token rotation(같은 계정)이면 in-place 갱신으로 세션을 유지한다.
    // 하지만 accountUuid 가 바뀐 재로그인/계정 교체면, 같은 tokenId 아래 살아남은 sessionCompat 가
    // 이전 계정으로 만든 session-id 를 새 계정 credentials 로 resume 시키는 격리 위반이 된다.
    // OpenAI dispatcher 가 login identity 변경을 worker restart 로 구분하는 것과 동일한 처리(codex P1):
    // identity 가 바뀌면 그 tokenId 의 세션 compat 을 폐기해 이후 호출이 cold 로 떨어지게 한다.
    const existing = this.tokenPool.get(id);
    const identityChanged =
      existing !== undefined && existing.credentials.accountUuid !== credentials.accountUuid;
    if (identityChanged) this.clearSessionCompatFor(id);
    this.tokenPool.set(id, { id, name, credentials });
  }
  onTokenRemoved(id: number): void {
    this.tokenPool.delete(id);
    this.requestCounts.delete(id);
    // 이 토큰으로 만든 세션의 compat 엔트리도 정리(codex P1).
    this.clearSessionCompatFor(id);
  }

  // 특정 tokenId 로 만든 모든 sessionCompat 엔트리 폐기(토큰 제거 / identity 변경 시 공통).
  private clearSessionCompatFor(tokenId: number): void {
    for (const [sid, e] of this.sessionCompat) {
      if (e.tokenId === tokenId) this.sessionCompat.delete(sid);
    }
  }

  // ── token selection (least-used RR, tokenId 기준) ────────────────

  private countOf(id: number): number {
    return this.requestCounts.get(id) ?? 0;
  }

  // cold 경로: least-used RR 로 토큰을 고른다(동점이면 rrIndex 로 회전).
  private selectToken(): PooledToken | null {
    const rows = [...this.tokenPool.values()];
    if (rows.length === 0) return null;
    const minCount = Math.min(...rows.map((r) => this.countOf(r.id)));
    const idle = rows.filter((r) => this.countOf(r.id) === minCount);
    const picked = idle[this.rrIndex % idle.length]!;
    this.rrIndex++;
    return this.charge(picked);
  }

  // resume 경로: 세션을 만든 토큰을 id 로 고정 선택한다. 풀에 없으면 null(→ cold fallback).
  // resume 세션은 그 토큰의 CLAUDE_CONFIG_DIR 에 transcript 가 묶여 있어, 다른 토큰으로 resume 하면
  // transcript 가 없어 깨진다. 그래서 RR 을 쓰지 않고 소유 토큰을 그대로 잡아야 한다(codex P0).
  private pickToken(id: number): PooledToken | null {
    const token = this.tokenPool.get(id);
    return token ? this.charge(token) : null;
  }

  // 선택된 토큰의 사용 카운트를 await 전에 선반영(동시 요청이 다른 토큰을 고르도록).
  private charge(token: PooledToken): PooledToken {
    this.requestCounts.set(token.id, this.countOf(token.id) + 1);
    return token;
  }

  // 만료된 compat 엔트리 정리(lazy sweep — generate 진입 시 호출).
  private sweepSessionCompat(): void {
    const now = Date.now();
    for (const [sid, e] of this.sessionCompat) {
      if (now - e.lastUsedAt > SESSION_COMPAT_TTL_MS) this.sessionCompat.delete(sid);
    }
  }

  // ── generate ──────────────────────────────────────────────────

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    return this.run(req, () => {});
  }

  async generateStream(req: GenerateRequest, cb: GenerateStreamCallbacks): Promise<void> {
    try {
      const result = await this.run(req, cb.onDelta);
      cb.onThreadId?.(result.threadCoord.threadId);
      cb.onComplete(result);
    } catch (e) {
      cb.onError(e as Error);
    }
  }

  // generate/generateStream 공통 실행. onDelta 는 스트림이면 점진 방출, 비스트림이면 no-op.
  private async run(req: GenerateRequest, onDelta: (t: string) => void): Promise<GenerateResult> {
    this.sweepSessionCompat();

    const model = req.model || ANTHROPIC_DEFAULT_MODEL;
    const jsonSchema =
      req.outputSchema !== undefined ? JSON.stringify(req.outputSchema) : undefined;
    const compat = compatibilityKey({ system: req.systemPrompt, model, outputSchema: jsonSchema });

    // ── resume eligibility + 토큰 선택 (codex P0: resume 는 세션 소유 토큰으로만) ──
    //  resume 가 성립하려면 세 조건이 모두 참이어야 한다:
    //   (a) reuse.threadId 의 저장된 호환키 == 이번 요청 호환키 (P1-5: 모델/system/schema 변경 오염 방지)
    //   (b) 저장된 tokenId == reuse.workerId (coord 왕복 무결성) 이고
    //   (c) 그 토큰이 아직 풀에 살아있음.
    //  하나라도 어긋나면 resume 불가 → cold 로 떨어지고 RR 로 새 토큰을 고른다.
    //  resume 일 때는 반드시 세션을 만든 그 토큰(stored.tokenId)을 고정 선택한다 — RR 로 다른 토큰을 잡으면
    //  그 토큰의 CLAUDE_CONFIG_DIR 에 transcript 가 없어 resume 이 깨진다.
    const candidate = req.reuse?.threadId;
    const stored = candidate !== undefined ? this.sessionCompat.get(candidate) : undefined;
    const ownerMatches = stored !== undefined && stored.tokenId === req.reuse?.workerId;
    const resumeToken =
      stored?.compat === compat && ownerMatches ? this.pickToken(stored.tokenId) : null;

    const isResume = resumeToken !== null;
    const resumeSessionId = isResume ? candidate : undefined;

    // resume 면 소유 토큰 고정, 아니면 cold RR 선택.
    const token = resumeToken ?? this.selectToken();
    if (!token) throw new Error("No anthropic tokens available");

    // 락 적용 범위 (codex U1 P0 반박 — 범위를 명시적으로 좁혀 둔다):
    //  (1) 구현 불가능: sessionKey 는 서버(GenerateRequest)로 오지 않는다. ai-sdk 클라이언트 store 가
    //      관리하고 서버엔 threadCoord 좌표만 회송하므로, "cold 별 sessionKey 단위 락"은 만들 입력 자체가
    //      없다. → U1 에서 강제할 수 없다.
    //  (2) 현재 scope 에서 불필요: 2026-06-06 sessionKey-conv 결정 문서(L21/L248)상 현재 IF/owner 사용은
    //      LLM 호출을 전부 순차(`await` 하나씩)로 돌려 같은 대화의 "동시 첫 호출"이 나지 않는다.
    //      ※ 이건 qgrid provider 일반 사용자가 같은 sessionKey 로 Promise.all 을 안 친다는 서버 계약은
    //        아니다 — 어디까지나 현재 IF/owner scope 의 호출 패턴 전제다. 향후 IF 가 LLM 호출을 병렬화하거나
    //        sessionKey 가 서버로 전달되도록 바뀌면 cold 첫-호출 락을 재검토해야 한다(2026-06-06 L248).
    //  → 따라서 락은 **resume 시 같은 claude session-id 동시 turn** 직렬화만 담당한다(transcript 오염 방지,
    //    U4 withSessionLock). cold 는 새 random session-id 라 충돌 불가하므로 락을 걸지 않는다.
    const exec = async (): Promise<GenerateResult> => {
      // 만료 임박 토큰 preemptive refresh(codex P1 — 기존 standalone 경로와 동일). 실패해도 진행.
      let accessToken = token.credentials.accessToken;
      const expiresAt = getExpiresAt(token.credentials);
      if (
        expiresAt &&
        expiresAt - Date.now() < REFRESH_SAFETY_MS &&
        getRefreshToken(token.credentials)
      ) {
        try {
          const { QgridFrame } = await import("../../../application/qgrid/qgrid.frame");
          // provider 를 반드시 채워야 refreshToken 내부 TokenModel.save 가 성공한다(codex P1).
          // refreshToken(TokenSubsetA) 는 id/provider/credentials/name 만 사용하므로 그 4개만 넘긴다.
          accessToken = await QgridFrame.refreshToken({
            id: token.id,
            provider: ANTHROPIC_PROVIDER,
            name: token.name,
            credentials: token.credentials,
          } as Parameters<typeof QgridFrame.refreshToken>[0]);
        } catch (e) {
          logger.warn(`refresh failed for ${token.name}: ${(e as Error).message}`);
        }
      }

      logger.info(`→ ${token.name} (model: ${model}, ${isResume ? "resume" : "cold"})`);

      const session = await runClaudeSession(
        {
          tokenId: token.id,
          token: accessToken,
          model,
          system: req.systemPrompt,
          jsonSchema,
          effort: req.effort,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          coldHistory: isResume ? undefined : req.coldHistory,
          input: isResume && req.reuseInput ? req.reuseInput : req.coldInput,
          resumeSessionId,
          abortSignal: req.abortSignal,
        },
        onDelta,
      );

      if (session.quotaExhausted) throw new Error(`quota exhausted (${token.name})`);
      if (session.isError) throw new Error(`claude error (${token.name}): ${session.text}`);

      // 발급한 session-id 의 호환키 저장(다음 resume 판정용). compat 는 여기 dispatcher-local 에만
      // 보존한다 — threadCoord.systemHash 로 왕복하지 않는다(codex P1-4 정정). 상위 issueConvContext
      // 가 systemHash 를 따로 채우지만 Anthropic resume eligibility 는 이 sessionCompat 가 단독 판정.
      this.sessionCompat.set(session.sessionId, {
        compat,
        tokenId: token.id,
        lastUsedAt: Date.now(),
      });

      return {
        text: session.text,
        tokenName: token.name,
        usage: session.usage,
        durationMs: session.durationMs,
        model,
        // threadCoord: threadId=session-id, epoch=0, workerId=tokenId. (systemHash 는 상위가 채움)
        threadCoord: {
          workerId: makeAnthropicWorkerId(token.id),
          threadId: session.sessionId,
          epoch: 0,
        },
      };
    };

    // resume 만 같은 session-id 단위로 직렬화. cold 는 락 없이 바로 실행.
    return resumeSessionId ? withSessionLock(resumeSessionId, exec) : exec();
  }
}
