import assert from "node:assert";
/**
 * QgridDispatcher — OAuth 토큰 선택 + claude CLI fresh spawn 디스패처 싱글턴.
 *
 * - 매 요청마다 새 claude CLI 프로세스 spawn → 응답 후 종료
 * - least-used round-robin 으로 토큰 선택
 * - 메모리 캐시 (Map<id, TokenSubsetA>) 는 TokenSubscriber 가 pg LISTEN/NOTIFY 로 갱신
 * - query 시 expires_at 비교 → 임박 시 preemptive refresh
 * - QuotaError 는 그대로 상위 전파 (자동 failover 없음, UI 에서 수동 토글)
 *
 * env allowlist: PATH, TMPDIR, CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CONFIG_DIR
 *   + CLAUDE_CODE_DISABLE_* + CLAUDE_CODE_ATTRIBUTION_HEADER
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

import { getLogger } from "@logtape/logtape";

import { type JsonValue } from "../../codex-protocol/serde_json/JsonValue";
import {
  getAccessToken,
  getExpiresAt,
  getRefreshToken,
} from "../../utils/providers/common/credentials";
import { calculateCostUsd } from "../../utils/providers/common/model-cost";
import { strictify } from "../../utils/providers/common/strictifier";
import { canonicalAnthropicModel } from "../../utils/providers/anthropic/anthropic-constants";
import { type AnthropicDispatcher } from "../../utils/providers/anthropic/anthropic-dispatcher";
import { type OpenAIDispatcher } from "../../utils/providers/openai/openai-dispatcher";
import { type TokenSubsetA } from "../sonamu.generated";
import { decideConvRouting, issueConvContext } from "./conv-routing";
import { type QueryInput, type QueryOutput, type TokenStats } from "./qgrid.types";
import { maskToken, ProcessError, QuotaError, TimeoutError } from "./qgrid.types";
import { type TokenSubscriber } from "./token-subscriber";
import { applyToolCallEmulation, buildToolCallSchema } from "./tool-emulation";

const logger = getLogger(["qgrid"]);

const DEFAULT_MODEL = "sonnet";
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_EFFORT = "high";

// claude CLI 의 cwd. 이 경로의 .claude/settings.json 이 project scope 로 로드되어
// 혹시라도 있을 user scope (~/.claude/settings.json)를 덮어씀 (--setting-sources project 와 함께).
const CLAUDE_CWD = "/tmp/qgrid";

// 글로벌 user config 격리 경로. (CC에서 환경변수로 읽는변수)
const CLAUDE_CONFIG_DIR = "/tmp/qgrid-config";

// qgrid 전용 project/global settings — user scope 격리용
const QGRID_CLAUDE_SETTINGS = {
  alwaysThinkingEnabled: false, // thinking block 차단
  includeGitInstructions: false, // system prompt 의 git 가이드 제거
  cleanupPeriodDays: 1,
};

// 토큰 만료 임박 임계값 — token.expiredAt이 1분 안에 만료된다면 query 시 체크하고 refresh.
const REFRESH_SAFETY_MS = 60_000;

export class QgridDispatcherClass {
  tokens = new Map<number, TokenSubsetA>();

  // key기반(tokenName) 누적 카운터. token 이 OAuth refresh 로 로테이트되도 tokenName 은 불변이라 카운터 유지됨
  requestCounts = new Map<string, number>();
  rrIndex = 0;

  // sonamu.config onStart 에서 처리하는 변수
  subscriber: TokenSubscriber | null = null;
  openaiDispatcher: OpenAIDispatcher | null = null;
  anthropicDispatcher: AnthropicDispatcher | null = null;

  constructor() {
    const settingsJson = JSON.stringify(QGRID_CLAUDE_SETTINGS, null, 2);

    mkdirSync(`${CLAUDE_CWD}/.claude`, { recursive: true });
    writeFileSync(`${CLAUDE_CWD}/.claude/settings.json`, settingsJson);

    mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });
    writeFileSync(`${CLAUDE_CONFIG_DIR}/.claude.json`, "{}");
    writeFileSync(`${CLAUDE_CONFIG_DIR}/settings.json`, settingsJson);
  }

  countOf(name: string): number {
    return this.requestCounts.get(name) ?? 0;
  }

  // TokenSubscriber 콜백 — 캐시 mutation
  upsertCache(id: number, row: TokenSubsetA): void {
    this.tokens.set(id, row);
  }

  removeCache(id: number): void {
    this.tokens.delete(id);
  }

  replaceCache(rows: TokenSubsetA[]): void {
    this.tokens = new Map(rows.map((r) => [r.id, r]));
  }

  getStats(): TokenStats[] {
    return [...this.tokens.values()].map((r) => ({
      token: maskToken(getAccessToken(r.credentials)),
      name: r.name,
      provider: r.provider,
      requests: this.countOf(r.name),
    }));
  }

  selectToken(provider = "anthropic"): TokenSubsetA | null {
    const rows = [...this.tokens.values()].filter((r) => r.provider === provider);
    if (rows.length === 0) return null;

    const minCount = Math.min(...rows.map((r) => this.countOf(r.name)));
    const idle = rows.filter((r) => this.countOf(r.name) === minCount);
    const picked = idle[this.rrIndex % idle.length]!;
    this.rrIndex++;
    return picked;
  }

  async query(input: QueryInput, timeoutMs?: number): Promise<QueryOutput> {
    if (input.tools?.length && input.jsonSchema) {
      throw new ProcessError("tools and jsonSchema cannot be used together");
    }

    const outputSchema = input.tools?.length
      ? buildToolCallSchema(input.tools)
      : input.jsonSchema
        ? (JSON.parse(input.jsonSchema) as JsonValue)
        : undefined;

    // provider prefix routing: 'openai/gpt-5.4' → OpenAIDispatcher
    if (input.model?.includes("/")) {
      const [provider, model] = input.model.split("/", 2);
      assert(model, "unknown model");
      if (provider === "openai") {
        if (!this.openaiDispatcher) throw new QuotaError("OpenAI dispatcher not initialized");
        const decision = decideConvRouting(input);
        const result = await this.openaiDispatcher.generate({
          model: model,
          systemPrompt: input.system,
          outputSchema: outputSchema
            ? (strictify(outputSchema as Parameters<typeof strictify>[0]) as JsonValue)
            : undefined,
          effort: input.effort,
          verbosity: input.verbosity,
          reasoningSummary: input.reasoningSummary,
          serviceTier: input.serviceTier,
          coldInput: decision.coldInput,
          coldHistory: decision.coldHistory,
          reuse: decision.reuse,
          reuseInput: decision.reuseInput,
        });

        const issuedCoord = issueConvContext(result.threadCoord, decision);
        return applyToolCallEmulation(
          {
            text: result.text,
            tokenName: result.tokenName,
            model: result.model,
            usage: {
              input_tokens: result.usage.inputTokens,
              output_tokens: result.usage.outputTokens,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: result.usage.cachedInputTokens,
            },
            durationMs: result.durationMs,
            costUsd: calculateCostUsd(result.model, {
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              cachedInputTokens: result.usage.cachedInputTokens,
            }),
          },
          input.tools,
          issuedCoord,
        );
      }
    }

    // Anthropic — AnthropicDispatcher(멀티턴 session resume) 경로.
    // OpenAI 경로와 동일하게 decideConvRouting → generate → issueConvContext → applyToolCallEmulation.
    if (this.anthropicDispatcher) {
      const decision = decideConvRouting(input);
      const result = await this.anthropicDispatcher.generate({
        // model 미지정이면 AnthropicDispatcher 가 ANTHROPIC_DEFAULT_MODEL 적용 — "sonnet" 별칭을
        // 강제로 끼워 U1 default 를 죽이지 않는다(codex P3). prefix 정규화도 dispatcher 내부에서.
        model: input.model,
        systemPrompt: input.system,
        outputSchema: outputSchema
          ? (strictify(outputSchema as Parameters<typeof strictify>[0]) as JsonValue)
          : undefined,
        effort: input.effort,
        coldInput: decision.coldInput,
        coldHistory: decision.coldHistory,
        reuse: decision.reuse,
        reuseInput: decision.reuseInput,
      });

      const issuedCoord = issueConvContext(result.threadCoord, decision);
      return applyToolCallEmulation(
        {
          text: result.text,
          tokenName: result.tokenName,
          model: result.model,
          usage: {
            input_tokens: result.usage.inputTokens,
            output_tokens: result.usage.outputTokens,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: result.usage.cachedInputTokens,
          },
          durationMs: result.durationMs,
          costUsd: calculateCostUsd(result.model, {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            cachedInputTokens: result.usage.cachedInputTokens,
          }),
        },
        input.tools,
        issuedCoord,
      );
    }

    // 폴백: AnthropicDispatcher 미초기화 시 기존 stateless claude -p 경로(멀티턴 없음).
    const executionInput =
      outputSchema && input.tools?.length
        ? { ...input, jsonSchema: JSON.stringify(outputSchema) }
        : input;

    const electedToken = this.selectToken();
    if (!electedToken) throw new QuotaError("No tokens available");

    // await 전에 count 선반영. 병렬 요청이 동시에 도착해도 각자 다른 토큰을 고르도록.
    this.requestCounts.set(electedToken.name, this.countOf(electedToken.name) + 1);

    let token = getAccessToken(electedToken.credentials);
    // expires_at 임박이면 preemptive refresh
    const expiresAt = getExpiresAt(electedToken.credentials);
    if (
      expiresAt &&
      expiresAt - Date.now() < REFRESH_SAFETY_MS &&
      getRefreshToken(electedToken.credentials)
    ) {
      try {
        const { QgridFrame } = await import("./qgrid.frame");
        token = await QgridFrame.refreshToken(electedToken);
      } catch (e) {
        logger.warn(`refresh failed for ${electedToken.name}: ${(e as Error).message}`);
      }
    }

    logger.info(`→ ${electedToken.name} (model: ${input.model ?? DEFAULT_MODEL})`);

    const result = await executeClaude(executionInput, token, timeoutMs ?? DEFAULT_TIMEOUT_MS);
    return applyToolCallEmulation(
      // model 도 canonical 로 — fallback 도 cost/표기가 main 경로와 일치하게(codex U5 P2).
      { ...result, tokenName: electedToken.name, model: canonicalAnthropicModel(input.model) },
      input.tools,
    );
  }

  async queryStream(
    input: QueryInput,
    cb: {
      onDelta: (text: string) => void;
      onComplete: (result: QueryOutput) => void;
      onError: (error: Error) => void;
      onThreadId?: (threadId: string) => void;
      onTurnId?: (turnId: string) => void;
    },
  ): Promise<void> {
    // Anthropic 스트리밍: openai/ prefix 가 아니면 anthropic 경로.
    if (!input.model?.startsWith("openai/")) {
      // AnthropicDispatcher 가 있으면 실제 delta 스트리밍. 없으면 기존 query() 폴백(delta 없음).
      if (this.anthropicDispatcher) {
        const outputSchema = input.tools?.length
          ? buildToolCallSchema(input.tools)
          : input.jsonSchema
            ? (JSON.parse(input.jsonSchema) as JsonValue)
            : undefined;
        const decision = decideConvRouting(input);
        await this.anthropicDispatcher.generateStream(
          {
            // model 미지정 시 dispatcher 가 ANTHROPIC_DEFAULT_MODEL 적용(codex P3). prefix 정규화도 내부에서.
            model: input.model,
            systemPrompt: input.system,
            outputSchema: outputSchema
              ? (strictify(outputSchema as Parameters<typeof strictify>[0]) as JsonValue)
              : undefined,
            effort: input.effort,
            coldInput: decision.coldInput,
            coldHistory: decision.coldHistory,
            reuse: decision.reuse,
            reuseInput: decision.reuseInput,
          },
          {
            onDelta: cb.onDelta,
            onThreadId: cb.onThreadId,
            onComplete: (turnResult) => {
              const issuedCoord = issueConvContext(turnResult.threadCoord, decision);
              const applied = applyToolCallEmulation(
                {
                  text: turnResult.text,
                  tokenName: turnResult.tokenName,
                  model: turnResult.model,
                  usage: {
                    input_tokens: turnResult.usage.inputTokens,
                    output_tokens: turnResult.usage.outputTokens,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: turnResult.usage.cachedInputTokens,
                  },
                  durationMs: turnResult.durationMs,
                  costUsd: calculateCostUsd(turnResult.model, {
                    inputTokens: turnResult.usage.inputTokens,
                    outputTokens: turnResult.usage.outputTokens,
                    cachedInputTokens: turnResult.usage.cachedInputTokens,
                  }),
                },
                input.tools,
                issuedCoord,
              );
              cb.onComplete(applied);
            },
            onError: cb.onError,
          },
        );
        return;
      }
      const result = await this.query(input);
      cb.onComplete(result);
      return;
    }

    const [, model] = input.model.split("/", 2);
    if (!model) throw new ProcessError("unknown model");
    if (!this.openaiDispatcher) throw new QuotaError("OpenAI dispatcher not initialized");

    const outputSchema = input.tools?.length
      ? buildToolCallSchema(input.tools)
      : input.jsonSchema
        ? (JSON.parse(input.jsonSchema) as JsonValue)
        : undefined;

    const decision = decideConvRouting(input);
    await this.openaiDispatcher.generateStream(
      {
        model,
        systemPrompt: input.system,
        outputSchema: outputSchema
          ? (strictify(outputSchema as Parameters<typeof strictify>[0]) as JsonValue)
          : undefined,
        effort: input.effort,
        verbosity: input.verbosity,
        reasoningSummary: input.reasoningSummary,
        serviceTier: input.serviceTier,
        coldInput: decision.coldInput,
        coldHistory: decision.coldHistory,
        reuse: decision.reuse,
        reuseInput: decision.reuseInput,
      },
      {
        onDelta: cb.onDelta,
        onThreadId: cb.onThreadId,
        onTurnId: cb.onTurnId,
        onComplete: (turnResult) => {
          const issuedCoord = issueConvContext(turnResult.threadCoord, decision);
          const applied = applyToolCallEmulation(
            {
              text: turnResult.text,
              tokenName: turnResult.tokenName,
              model: turnResult.model,
              usage: {
                input_tokens: turnResult.usage.inputTokens,
                output_tokens: turnResult.usage.outputTokens,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: turnResult.usage.cachedInputTokens,
              },
              durationMs: turnResult.durationMs,
              costUsd: calculateCostUsd(turnResult.model, {
                inputTokens: turnResult.usage.inputTokens,
                outputTokens: turnResult.usage.outputTokens,
                cachedInputTokens: turnResult.usage.cachedInputTokens,
              }),
            },
            input.tools,
            issuedCoord,
          );
          cb.onComplete(applied);
        },
        onError: cb.onError,
      },
    );
  }
}

async function executeClaude(
  input: QueryInput,
  token: string,
  timeoutMs: number,
): Promise<Omit<QueryOutput, "content" | "finishReason">> {
  const rawModel = input.model ?? DEFAULT_MODEL;
  const model = rawModel.includes("/") ? rawModel.split("/").pop()! : rawModel;
  const timeout = input.timeout ?? timeoutMs;
  const useStructuredOutput = input.jsonSchema && input.jsonSchema.length > 0;

  // --tools "" 로 모든 tool 을 기본 차단. structured output 쓰면 StructuredOutput 만 화이트리스트.
  // --tools "" 는 반드시 뒤에 다른 플래그가 와야 CLI 파싱이 빈 문자열로 인식
  const toolArgs = useStructuredOutput
    ? ["--tools", "", "--allowed-tools", "StructuredOutput"]
    : ["--tools", ""];

  const args: string[] = [
    "-p",
    ...toolArgs,
    "--disallowedTools",
    // CC에서 자동 활성화되는 deferred 도구. 토큰 최적화를위해 차단
    ...(["Monitor", "PushNotification", "RemoteTrigger"] as const),
    "--output-format",
    "stream-json",
    "--verbose",
    // --max-turns: structured output 은 tool_use + tool_result 로 2턴 소비
    "--max-turns",
    useStructuredOutput ? "2" : "1",
    "--permission-mode",
    "bypassPermissions",
    "--setting-sources",
    "project",
    "--model",
    model,
    // --system-prompt는 반드시 명시해야함. 옵션 생략 시 CC가 default system prompt를 자동으로 주입함(23k)
    "--system-prompt",
    input.system ?? "",
    "--thinking",
    "disabled",
    "--effort",
    input.effort ?? DEFAULT_EFFORT,
    "--no-session-persistence",
    // 모든 skills 비활성화
    "--disable-slash-commands",
  ];
  if (useStructuredOutput) {
    args.push("--json-schema", input.jsonSchema!);
  }
  args.push(input.prompt);

  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    CLAUDE_CODE_OAUTH_TOKEN: token,
    // CLAUDE_CONFIG_DIR 환경변수로 주입
    CLAUDE_CONFIG_DIR,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "1",
    CLAUDE_CODE_DISABLE_1M_CONTEXT: "1",
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
    CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
  };

  return new Promise<Omit<QueryOutput, "content" | "finishReason">>((resolve, reject) => {
    const child = spawn("claude", args, {
      stdio: ["ignore", "pipe", "ignore"],
      env,
      // 격리 (두 단계):
      // 1. CLAUDE_CWD — project scope 격리 (cwd 의 .claude/settings.json)
      // 2. CLAUDE_CONFIG_DIR — user scope 격리 cwd 격리만으론 부족.
      cwd: CLAUDE_CWD,
    });

    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new TimeoutError(`Timeout after ${timeout / 1000}s (token: ${maskToken(token)})`));
    }, timeout);

    child.stdout?.on("data", (d: Buffer) => {
      if (settled) return;
      buffer += d.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const j = JSON.parse(line);
          if (j.type === "result" && !settled) {
            // --json-schema 사용 시 structured_output 에 파싱된 객체가 온다 → 우선 사용
            let text: string;
            if (j.structured_output !== undefined) {
              text = JSON.stringify(j.structured_output);
            } else {
              text = (j.result ?? "")
                .replace(/^```(?:json)?\s*\n?/i, "")
                .replace(/\n?```\s*$/i, "");
            }

            if (text.startsWith("You've hit")) {
              settled = true;
              clearTimeout(timer);
              reject(new QuotaError(`Quota exhausted (token: ${maskToken(token)})`));
              return;
            }

            const u = j.usage ?? {};
            settled = true;
            clearTimeout(timer);
            resolve({
              text,
              usage: {
                input_tokens: u.input_tokens ?? 0,
                output_tokens: u.output_tokens ?? 0,
                cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
                cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
              },
              durationMs: j.duration_ms ?? 0,
              costUsd: j.total_cost_usd ?? 0,
            });
          }
        } catch {}
      }
    });

    child.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ProcessError(`CLI process closed without result (token: ${maskToken(token)})`));
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ProcessError(`CLI process error: ${err.message} (token: ${maskToken(token)})`));
    });
  });
}

export const QgridDispatcher = new QgridDispatcherClass();
