/**
 * AnthropicDispatcher
 *
 * OpenAIDispatcher와 달리, worker pool을 두는 대신 요청별 fresh spawn
 * 토큰은 인메모리(MAP)으로 관리하고 smooth weighted round-robin 으로 고른다
 *
 * - 모든 요청은 fresh `--session-id` 로 실행
 * - 멀티턴 문맥은 클라이언트가 매 호출 보내는 full history 를 평탄화해 전달한다.
 * - 발급한 session-id 를 GenerateResult.threadCoord(threadId=session-id, workerId=tokenId,
 *   epoch=0)로 올려, 상위(issueConvContext)가 클라에 회송할 좌표를 만든다. 다음 turn 이 좌표를
 *   회송해도 Anthropic 라우팅에는 쓰지 않는다.
 */

import { getLogger } from "@logtape/logtape";

import { QuotaThresholdExceededError } from "../../../application/qgrid/qgrid.types";
import { TokenModel } from "../../../application/token/token.model";
import { type AnthropicCredentials } from "../../../application/token/token.types";
import { getExpiresAt, getRefreshToken } from "../common/credentials";
import {
  type GenerateRequest,
  type GenerateResult,
  type GenerateStreamCallbacks,
  type ProviderDispatcher,
} from "../common/provider-dispatcher";
import { serializeAndValidateDispatchSchema } from "../common/schema-validation";
import { SmoothWeightedRoundRobin } from "../common/smooth-weighted-round-robin";
import { assertSupportedOneMillionSuffix, canonicalAnthropicModel } from "./anthropic-constants";
import { readAnthropicQuotaUsage, type AnthropicQuotaUsageResult } from "./anthropic-quota";
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
  quotaThreshold?: number | null;
  weight: number;
}

function quotaThresholdExceededMessage(
  provider: string,
  tokens: Array<{ tokenName: string; threshold: number }>,
): string {
  const details = tokens
    .map((token) => `${token.tokenName} (threshold ${token.threshold}%)`)
    .join(", ");
  return details.length > 0
    ? `All ${provider} tokens exceeded quota threshold: ${details}`
    : `All ${provider} tokens exceeded quota threshold`;
}

export class AnthropicDispatcher implements ProviderDispatcher {
  // tokenId → 풀 항목. start()/token 이벤트로 채움
  private tokenPool = new Map<number, PooledToken>();
  private readonly weightedSelector = new SmoothWeightedRoundRobin();

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
        quotaThreshold: t.quota_threshold,
        weight: t.weight,
      });
      this.weightedSelector.setToken(t.id, t.weight);
      logger.info(`worker spawned: ${t.name}`);
    }
  }

  async stop(): Promise<void> {
    const tokenIds = [...this.tokenPool.keys()];
    for (const id of tokenIds) this.weightedSelector.removeToken(id);
    this.tokenPool.clear();
    this.weightedSelector.resetScores();
  }

  // 현재 풀의 토큰 수(startup 로그/health 용).
  get tokenCount(): number {
    return this.tokenPool.size;
  }

  // Monit 표시용 — 풀에 있는 토큰 이름 스냅샷 (이름순 정렬)
  get tokenNames(): string[] {
    return [...this.tokenPool.values()].map((token) => token.name).toSorted();
  }

  // DB active anthropic 토큰 목록으로 풀을 재동기화한다(periodic reconcile/재연결용).
  // LISTEN/NOTIFY 가 끊긴 동안 유실된 추가/삭제/비활성화를 DB 기준으로 다시 맞춘다.
  // 이벤트 핸들러를 재사용해 풀 갱신이 일관되게 적용되도록 한다:
  //  - DB 에 없는데 풀에 있는 토큰 → onTokenRemoved
  //  - DB 에 있는 토큰 → 신규면 onTokenAdded, 기존이면 onTokenUpdated
  replaceTokens(
    rows: Array<{
      id: number;
      name: string;
      credentials: AnthropicCredentials;
      quotaThreshold?: number | null;
      weight: number;
    }>,
  ): void {
    const next = new Set(rows.map((r) => r.id));
    // onTokenRemoved 가 tokenPool 을 delete 하므로 순회 중 수정을 피하려 키를 먼저 스냅샷한다.
    const currentIds = Array.from(this.tokenPool.keys());
    for (const id of currentIds) {
      if (!next.has(id)) this.onTokenRemoved(id);
    }
    for (const r of rows) {
      if (this.tokenPool.has(r.id)) {
        this.onTokenUpdated(r.id, r.name, r.credentials, r.quotaThreshold, r.weight);
      } else {
        this.onTokenAdded(r.id, r.name, r.credentials, r.quotaThreshold, r.weight);
      }
    }
  }

  // token events (token-subscriber 가 호출)
  onTokenAdded(
    id: number,
    name: string,
    credentials: AnthropicCredentials,
    quotaThreshold?: number | null,
    weight = 1,
  ): void {
    this.tokenPool.set(id, { id, name, credentials, quotaThreshold, weight });
    this.weightedSelector.setToken(id, weight);
  }

  onTokenUpdated(
    id: number,
    name: string,
    credentials: AnthropicCredentials,
    quotaThreshold?: number | null,
    weight = 1,
  ): void {
    this.tokenPool.set(id, { id, name, credentials, quotaThreshold, weight });
    this.weightedSelector.setToken(id, weight);
  }

  onTokenRemoved(id: number): void {
    this.tokenPool.delete(id);
    this.weightedSelector.removeToken(id);
  }

  // quota 통과 후보만으로 요청마다 smooth weighted round-robin 선택한다.
  private async selectToken(): Promise<PooledToken | null> {
    const rows = [...this.tokenPool.values()];
    if (rows.length === 0) return null;
    const { eligible, overThresholdTokens } = await this.filterEligibleTokens(rows);
    if (eligible.length === 0) {
      logger.warn("quota_threshold gate: all_exceeded", {
        provider: "anthropic",
        tokenCount: rows.length,
        thresholdedTokenCount: rows.filter((r) => this.hasQuotaThreshold(r)).length,
        overThresholdTokens,
        reason: "all_exceeded",
      });
      throw new QuotaThresholdExceededError(
        quotaThresholdExceededMessage("anthropic", overThresholdTokens),
      );
    }

    const selectedId = this.weightedSelector.select(new Set(eligible.map((token) => token.id)));
    if (selectedId === null) return null;
    return this.tokenPool.get(selectedId) ?? null;
  }

  private async filterEligibleTokens(rows: PooledToken[]): Promise<{
    eligible: PooledToken[];
    overThresholdTokens: Array<{ tokenName: string; threshold: number }>;
  }> {
    const thresholded = rows.filter((token) => this.hasQuotaThreshold(token));
    if (thresholded.length === 0) return { eligible: rows, overThresholdTokens: [] };

    const eligibleIds = new Set(
      rows.filter((token) => !this.hasQuotaThreshold(token)).map((token) => token.id),
    );
    const overThresholdTokens: Array<{ tokenName: string; threshold: number }> = [];
    const checks = await Promise.allSettled(
      thresholded.map(async (token) => ({
        token,
        result: await readAnthropicQuotaUsage(token.credentials.accessToken),
      })),
    );

    checks.forEach((check, index) => {
      if (check.status === "rejected") {
        const token = thresholded[index];
        if (!token) return;
        this.logQuotaLookupFailOpen(token, String(check.reason));
        eligibleIds.add(token.id);
        return;
      }

      const token = check.value.token;
      const result = check.value.result;
      if (result.kind === "lookup_failed") {
        this.logQuotaLookupFailOpen(token, result.reason);
        eligibleIds.add(token.id);
        return;
      }

      if (result.utilizationPct >= token.quotaThreshold) {
        this.logQuotaOverThreshold(token, result);
        overThresholdTokens.push({ tokenName: token.name, threshold: token.quotaThreshold });
        return;
      }

      eligibleIds.add(token.id);
    });

    return { eligible: rows.filter((token) => eligibleIds.has(token.id)), overThresholdTokens };
  }

  private hasQuotaThreshold(token: PooledToken): token is PooledToken & { quotaThreshold: number } {
    return token.quotaThreshold !== undefined && token.quotaThreshold !== null;
  }

  private logQuotaOverThreshold(
    token: PooledToken & { quotaThreshold: number },
    result: Extract<AnthropicQuotaUsageResult, { kind: "ok" }>,
  ): void {
    logger.info("quota_threshold gate: over_threshold", {
      tokenId: token.id,
      tokenName: token.name,
      provider: "anthropic",
      threshold: token.quotaThreshold,
      cachedUtilization: result.utilizationPct,
      cacheAge: result.cacheAgeMs,
      reason: "over_threshold",
    });
  }

  private logQuotaLookupFailOpen(
    token: PooledToken & { quotaThreshold: number },
    reason: string,
  ): void {
    logger.warn("quota_threshold gate: lookup_fail_open", {
      tokenId: token.id,
      tokenName: token.name,
      provider: "anthropic",
      threshold: token.quotaThreshold,
      reason: "lookup_fail_open",
      lookupReason: reason,
    });
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
    // 이미지 생성은 OpenAI(codex) 경로 전용. Anthropic 라우팅에 이미지 플래그가
    // 도달하면 조용히 텍스트로 폴백하지 않고 명시적으로 거부한다.
    if (req.imageGeneration) {
      throw new Error("image generation is not supported on the Anthropic route");
    }
    // model 정규화를 dispatcher 진입점에서 한 번 한다: result.model / runClaudeSession 전부
    // canonical(prefix 없는 cost 키) 을 쓰게 통일. 미지정이면 ANTHROPIC_DEFAULT_MODEL — qgrid.dispatcher
    // 의 "sonnet" 별칭 우회 차단. 정규화 규칙은 fallback 경로와 공유(canonicalAnthropicModel).
    assertSupportedOneMillionSuffix(req.model);
    const model = canonicalAnthropicModel(req.model);
    const jsonSchema = serializeAndValidateDispatchSchema(req.outputSchema, "anthropic");

    const token = await this.selectToken();
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
          timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          coldHistory: req.coldHistory,
          input: req.coldInput,
          abortSignal: req.abortSignal,
          includePartialMessages: opts?.includePartialMessages,
        },
        onDelta,
      );

      if (session.quotaExhausted) throw new Error(`quota exhausted (${token.name})`);
      if (session.isError) {
        // 진단(SON-495): isError 판정 사유(subtype/terminal_reason)를 메시지 앞에 드러낸다.
        // 그동안 detail 이 session.text(완전한 JSON 본문)뿐이라 "schema 위반인지 / max retries 인지 /
        // max turns 인지"를 구분할 수 없었다. text 는 진단에 필요한 만큼만 잘라 덧붙인다.
        const reason =
          session.subtype ?? session.terminalReason ?? (session.isError ? "is_error" : "unknown");
        const body = session.text
          ? session.text.length > 500
            ? `${session.text.slice(0, 500)}…(${session.text.length} chars)`
            : session.text
          : `empty text, outputTokens=${session.usage.outputTokens}`;
        const refusal = session.refusal ? ` refusal=${JSON.stringify(session.refusal)}` : "";
        throw new Error(`claude error (${token.name}) [${reason}]: ${body}${refusal}`);
      }

      return {
        text: session.text,
        tokenName: token.name,
        usage: session.usage,
        durationMs: session.durationMs,
        ttftMs: session.ttftMs,
        costUsd: session.costUsd,
        // Claude Code 는 Fable refusal 을 Opus 로 자동 fallback 할 수 있다. 요청 모델을
        // 그대로 serving model 로 기록하면 비용/감사 로그가 모두 틀어지므로 둘을 구분한다.
        model: session.servedModel ?? model,
        requestedModel: model,
        modelFallbacks: session.modelFallbacks,
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
