/**
 * QgridDispatcher — OAuth 토큰 선택 + claude CLI fresh spawn 디스패처 싱글턴.
 *
 * - 매 요청마다 새 claude CLI 프로세스 spawn → 응답 후 종료
 * - system 은 --append-system-prompt 로 분리 전달 (user turn 오염 방지)
 * - least-used round-robin 으로 토큰 선택
 * - 메모리 캐시 (Map<id, TokenSubsetA>) 는 TokenSubscriber 가 pg LISTEN/NOTIFY 로 갱신
 * - query 시 expires_at 비교 → 임박 시 preemptive refresh
 * - QuotaError 는 그대로 상위 전파 (자동 failover 없음, UI 에서 수동 토글)
 *
 * env allowlist: PATH, TMPDIR, CLAUDE_CODE_OAUTH_TOKEN + CLAUDE_CODE_DISABLE_*
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

import { getLogger } from "@logtape/logtape";

import { type TokenSubsetA } from "../sonamu.generated";
import { type CliResult, type QueryInput, type TokenStats } from "./qgrid.types";
import { maskToken, ProcessError, QuotaError, TimeoutError } from "./qgrid.types";
import { type TokenSubscriber } from "./token-subscriber";

const logger = getLogger(["qgrid"]);

const DEFAULT_MODEL = "sonnet";
const DEFAULT_TIMEOUT_MS = 600_000;

// claude CLI 의 cwd. 이 경로의 .claude/settings.json 이 project scope 로 로드되어
// 혹시라도 있을 user scope (~/.claude/settings.json)를 덮어씀 (--setting-sources project 와 함께).
const CLAUDE_CWD = "/tmp/qgrid";

// qgrid 전용 project settings — user scope 격리용
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

  constructor() {
    mkdirSync(`${CLAUDE_CWD}/.claude`, { recursive: true });
    writeFileSync(
      `${CLAUDE_CWD}/.claude/settings.json`,
      JSON.stringify(QGRID_CLAUDE_SETTINGS, null, 2),
    );
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
      token: r.token,
      name: r.name,
      requests: this.countOf(r.name),
    }));
  }

  selectToken(): TokenSubsetA | null {
    const rows = [...this.tokens.values()];
    if (rows.length === 0) return null;

    const minCount = Math.min(...rows.map((r) => this.countOf(r.name)));
    const idle = rows.filter((r) => this.countOf(r.name) === minCount);
    const picked = idle[this.rrIndex % idle.length]!;
    this.rrIndex++;
    return picked;
  }

  async query(input: QueryInput, timeoutMs?: number): Promise<CliResult> {
    const electedToken = this.selectToken();
    if (!electedToken) throw new QuotaError("No tokens available");

    // await 전에 count 선반영. 병렬 요청이 동시에 도착해도 각자 다른 토큰을 고르도록.
    this.requestCounts.set(electedToken.name, this.countOf(electedToken.name) + 1);

    let token = electedToken.token;
    // expires_at 임박이면 refresh.
    // refresh 후 DB save → trigger NOTIFY → subscriber 가 받아 캐시 갱신 (다른 dispatcher 도 동기화)
    if (
      electedToken.expires_at &&
      Number(electedToken.expires_at) - Date.now() < REFRESH_SAFETY_MS &&
      electedToken.refresh_token
    ) {
      try {
        const { QgridFrame } = await import("./qgrid.frame");
        token = await QgridFrame.refreshToken({
          id: electedToken.id,
          token: electedToken.token,
          name: electedToken.name,
          refresh_token: electedToken.refresh_token,
        });
      } catch (e) {
        logger.warn(`refresh failed for ${electedToken.name}: ${(e as Error).message}`);
        // refresh 실패 시 기존 token 으로 진행. executeClaude 가 401 받으면 caller 처리.
      }
    }

    logger.info(`→ ${electedToken.name} (model: ${input.model ?? DEFAULT_MODEL})`);

    const result = await executeClaude(input, token, timeoutMs ?? DEFAULT_TIMEOUT_MS);
    return { ...result, tokenName: electedToken.name, model: input.model ?? DEFAULT_MODEL };
  }
}

async function executeClaude(
  input: QueryInput,
  token: string,
  timeoutMs: number,
): Promise<CliResult> {
  const model = input.model ?? DEFAULT_MODEL;
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
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-turns",
    // structured output 은 tool_use + tool_result 로 2턴 소비
    useStructuredOutput ? "2" : "1",
    "--permission-mode",
    "bypassPermissions",
    "--setting-sources",
    "project",
    "--model",
    model,
    // thinking 비활성화는 project settings (alwaysThinkingEnabled: false) 에서 처리
    "--exclude-dynamic-system-prompt-sections", // cwd/env 를 user msg 로 이동 → prefix cache 안정화
    "--no-session-persistence", // ~/.claude/projects/ 의 orphan jsonl 누적 방지
  ];
  if (useStructuredOutput) {
    args.push("--json-schema", input.jsonSchema!);
  }
  if (input.system) {
    args.push("--append-system-prompt", input.system);
  }
  args.push(input.prompt);

  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    CLAUDE_CODE_OAUTH_TOKEN: token,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "1",
    CLAUDE_CODE_DISABLE_1M_CONTEXT: "1",
  };

  return new Promise<CliResult>((resolve, reject) => {
    const child = spawn("claude", args, {
      stdio: ["ignore", "pipe", "ignore"],
      env,
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
