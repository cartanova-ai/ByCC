/**
 * claude-session — Claude CLI 세션 spawn + QgridThreadCoord 매핑 + per-session 락.
 *
 * 멀티턴: 매 호출 fresh `--session-id <uuid>`로 실행한다. 입력은 어댑터가 만든 JSONL 을
 * stdin 으로 흘리고(`--input-format stream-json`), 출력은 파서로 처리한다.
 *
 * 핵심 계약:
 *  - coord 는 임의 저장이 아니라 기존 QgridThreadCoord{workerId,threadId,epoch,systemHash} 에
 *    매핑한다. threadId=세션 uuid, epoch=0 고정(worker restart 개념 없음), workerId=token 기반
 *    안정 합성, systemHash=요청 system 해시. issueConvContext/decideConvRouting 과 round-trip.
 *  - withSessionLock 은 exported primitive 로 유지한다. 기본 경로에서는 매 호출 새 session-id 라
 *    사실상 no-contention 이지만, 직접 호출자/테스트의 직렬화 보장은 보존한다.
 *  - stream-json 직렬화 시 SDK envelope(uuid/session_id/parent_tool_use_id) decorate.
 *  - structured output 일 때 출력 파서에 { structuredOutput: true } 전달(없으면 streamObject 깨짐).
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";

import { resolveAnthropicEffort } from "../common/effort";
import { type JsonValue, type TokenUsageBreakdown, type UserInput } from "../common/provider-types";
import {
  ARGV_SAFE_MAX_UTF8_BYTES,
  assertAnthropicSchemaArgvSize,
} from "../common/schema-validation";
import { createTtftTracker } from "../common/ttft";
import {
  ANTHROPIC_CLAUDE_CWD,
  anthropicConfigDir,
  ANTHROPIC_DEFAULT_EFFORT,
  ANTHROPIC_DISALLOWED_TOOLS,
  assertSupportedOneMillionSuffix,
  canonicalAnthropicModel,
  needsCli1mSuffix,
  supports1MContext,
  usesAdaptiveThinking,
} from "./anthropic-constants";
import {
  buildStreamJsonInput,
  type ClaudeStreamJsonState,
  type ClaudeStreamJsonLine,
  type ClaudeStreamResult,
  handleStreamJsonLine,
} from "./stream-json-adapter";

// ── per-session 락 ─────────────────────────────────────────────────

// session-id 단위 직렬화 primitive. 기본 경로에서는 매 호출 새 uuid 라 사실상 no-op 이지만,
// 같은 session-id 를 직접 쓰는 호출자는 여전히 직렬화 보장을 받는다.
const sessionChains = new Map<string, Promise<unknown>>();

export async function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = sessionChains.get(sessionId) ?? Promise.resolve();
  // 이전 turn 의 성패와 무관하게 직렬 체인을 잇는다.
  const next = prev.then(fn, fn);
  // tail: 성패 무관 settle 되는 핸들. 이걸 맵에 두고, finally 에서 "여전히 내가 끝"일 때만 삭제.
  // (set 직후 undefined 검사로 하면 절대 삭제 안 돼 세션 id 가 누수됨 — tail 일치 검사로 회피.)
  const tail = next.then(
    () => {},
    () => {},
  );
  sessionChains.set(sessionId, tail);
  try {
    return await next;
  } finally {
    // 그 사이 다른 turn 이 체인을 이어받았으면 tail 이 교체돼 있다 — 그때는 삭제하지 않는다.
    if (sessionChains.get(sessionId) === tail) sessionChains.delete(sessionId);
  }
}

// ── coord 매핑 ──────────────────────────────────────────────────────

// token 기반 안정 workerId 합성. Anthropic 은 worker pool 이 없으므로 tokenId 를 그대로 쓴다.
export function makeAnthropicWorkerId(tokenId: number): number {
  return tokenId;
}

// ── envelope decorate ──────────────────────────────────────────────

// stream-json 입력 라인에 SDK envelope 부착 후 직렬화. session 소유자인 여기서 한다.
export function decorateAndSerialize(
  lines: Array<ClaudeStreamJsonLine>,
  sessionId: string,
): string {
  return (
    lines
      .map((line) =>
        JSON.stringify({
          ...line,
          session_id: sessionId,
          uuid: randomUUID(),
          parent_tool_use_id: null,
        }),
      )
      .join("\n") + "\n"
  );
}

// ── spawn + consume ────────────────────────────────────────────────

export interface ClaudeSessionRequest {
  tokenId: number;
  token: string; // OAuth access token
  model: string;
  system?: string;
  jsonSchema?: string; // 있으면 structured output
  effort?: string;
  timeoutMs: number;
  coldHistory?: Array<JsonValue>;
  input: Array<UserInput>;
  abortSignal?: AbortSignal;
  includePartialMessages?: boolean;
}

export interface ClaudeSessionResult extends ClaudeStreamResult {
  sessionId: string;
  workerId: number;
  ttftMs: number | null;
}

// per-token CLAUDE_CONFIG_DIR 보장(격리). 경로 규칙은 anthropicConfigDir(순수 함수)이 소유 —
// 여기선 그 경로에 빈 settings 를 깔아 claude-mem hook 등을 차단한다. (R10 격리)
// 이 seed 파일은 claude-mem hook / 사용자 설정 오염 차단을 위한 격리 경계다. 매 호출마다 다시 써서
// 외부 변조·삭제 후에도 다음 실행에서 self-healing 되도록 기존 semantics 를 유지한다.
export function ensureConfigDir(tokenId: number): string {
  const dir = anthropicConfigDir(tokenId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/.claude.json`, "{}");
  writeFileSync(`${dir}/settings.json`, "{}");
  return dir;
}

let cwdEnsured = false;
function ensureCwd(): void {
  if (cwdEnsured) return;
  mkdirSync(`${ANTHROPIC_CLAUDE_CWD}/.claude`, { recursive: true });
  writeFileSync(`${ANTHROPIC_CLAUDE_CWD}/.claude/settings.json`, "{}");
  cwdEnsured = true;
}

// spawn args 구성. 멀티턴/격리/structured 모드 반영.
export function applyOneMillionSuffix(model: string, needsSuffix: boolean): string {
  const base = canonicalAnthropicModel(model);
  return needsSuffix ? `${base}[1m]` : base;
}

export function oneMillionEnv(supported: boolean): { CLAUDE_CODE_DISABLE_1M_CONTEXT?: "1" } {
  return supported ? {} : { CLAUDE_CODE_DISABLE_1M_CONTEXT: "1" };
}

export function thinkingEnv(model: string): {
  CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING?: "1";
  MAX_THINKING_TOKENS?: "0";
} {
  return usesAdaptiveThinking(model)
    ? {}
    : {
        CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "1",
        MAX_THINKING_TOKENS: "0",
      };
}

// SON-495: structured output retry 를 1 로 고정한다. CC 가 attempt 를 reject 하고 retry 하면
// `{rejected}{accepted}` 누적이 AI-SDK 의 JSON.parse 를 깨뜨리므로, retry 자체를 막아 그 경로를
// 원천 차단한다. `0` 은 CC query loop(`callsThisQuery >= maxRetries`)가 첫 attempt emit 전에
// 실패시키므로(`error_max_structured_output_retries`) 외부 값이 1 미만이어도 1 로 클램프한다.
export function structuredOutputRetriesEnv(raw = process.env.MAX_STRUCTURED_OUTPUT_RETRIES): {
  MAX_STRUCTURED_OUTPUT_RETRIES: string;
} {
  if (!raw) return { MAX_STRUCTURED_OUTPUT_RETRIES: "1" };
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return { MAX_STRUCTURED_OUTPUT_RETRIES: "1" };
  return { MAX_STRUCTURED_OUTPUT_RETRIES: String(Math.max(parsed, 1)) };
}

// SON-495 의 retry 고정은 "스트리밍 + structured" 조합 한정 정책이다. 스트림에서 retry 가 돌면
// wall-clock 이 2배가 되어 실용성이 없기 때문이다(원 결정 사유). 논스트림 generate 는 애초에 완료를
// 기다리므로 그 사유가 성립하지 않는다. 반면 Claude 계열은 OpenAI 대비 structured output 준수율이
// 낮아, 논스트림까지 retry=1 로 묶으면 1회 reject 가 곧바로
// `error_max_structured_output_retries` 로 직결된다(실측: deti_production opus-4-8 실패율 39.6%).
// 스트리밍 여부는 `--include-partial-messages` 를 붙이는 generateStream 경로에서만 true 가 되므로
// (anthropic-dispatcher 의 generate/generateStream 분기) 이를 실질 구분자로 쓴다.
// 비성공 subtype 을 항상 isError 로 올리는 SON-495 의 나머지 절반은 그대로 유지된다 — retry 후에도
// degenerate 출력이면 조용히 통과시키지 않고 정직하게 실패한다.
export function shouldPinStructuredRetries(opts: {
  useStructured: boolean;
  includePartialMessages?: boolean;
}): boolean {
  return opts.useStructured && opts.includePartialMessages === true;
}

// Linux 단일 argv 인자 한계(MAX_ARG_STRLEN = PAGE_SIZE×32 = 128KB, 커널 하드코딩 상수)
// 시스템 프롬프트가 이를 넘으면 execve 가 E2BIG 로 거부된다. deti 등 대형 프롬프트는 실측
// 평균 343KB·최대 485KB(opus-4-8)라 일상적으로 초과한다. 한계의 절반(64KB)을 임계값으로 잡아
// UTF-8 멀티바이트·예측 못 한 여유분까지 안전 마진을 둔다.
export const SYSTEM_PROMPT_ARGV_MAX_BYTES = ARGV_SAFE_MAX_UTF8_BYTES;

export function buildClaudeArgs(opts: {
  model: string;
  // 시스템 프롬프트 전달은 크기로 분기한다(호출부가 결정):
  //  - 작으면 system(inline) → --system-prompt <text> (파일 I/O 없음, 기존 경로)
  //  - 크면 systemPromptFile(경로) → --system-prompt-file <path> (argv 한계 회피)
  // --system-prompt-file 은 --system-prompt 와 동일하게 default 를 replace 한다(append 아님 —
  // R7 격리 보존, 실측 확인). 둘 다 없으면 빈 --system-prompt(default 23k 주입 방지).
  system?: string;
  systemPromptFile?: string;
  effort?: string;
  jsonSchema?: string;
  sessionId: string;
  needsOneMillionSuffix?: boolean;
  includePartialMessages?: boolean;
}): Array<string> {
  const useStructured = Boolean(opts.jsonSchema && opts.jsonSchema.length > 0);
  if (useStructured) assertAnthropicSchemaArgvSize(opts.jsonSchema!);
  // --tools "" 로 전체 차단, structured(jsonSchema 있음) 면 StructuredOutput 만 허용.
  const toolArgs = useStructured
    ? ["--tools", "", "--allowed-tools", "StructuredOutput"]
    : ["--tools", ""];

  // 시스템 프롬프트: 파일 경로가 오면 --system-prompt-file, 아니면 inline --system-prompt.
  // (호출부가 크기로 분기해 둘 중 하나만 채운다. 둘 다 없으면 빈 --system-prompt.)
  const systemArgs = opts.systemPromptFile
    ? ["--system-prompt-file", opts.systemPromptFile]
    : ["--system-prompt", opts.system ?? ""];

  const args: Array<string> = [
    "-p",
    ...toolArgs,
    "--disallowedTools",
    ...ANTHROPIC_DISALLOWED_TOOLS,
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    ...(opts.includePartialMessages ? ["--include-partial-messages"] : []),
    "--permission-mode",
    "bypassPermissions",
    "--setting-sources",
    "project",
    "--model",
    applyOneMillionSuffix(opts.model, opts.needsOneMillionSuffix ?? false),
    // inline [System] 금지 — 정식 채널만(R7). 생략 시 CC default(23k) 주입되므로 반드시 명시.
    // 크기에 따라 --system-prompt(작음) / --system-prompt-file(큼)로 분기(systemArgs).
    ...systemArgs,
    // Fable 5 는 adaptive thinking 이 필수이고, Opus 5 는 공식 기본 adaptive 동작을 보존한다.
    ...(usesAdaptiveThinking(opts.model) ? [] : ["--thinking", "disabled"]),
    // Claude Code 어휘 밖의 effort(OpenAI 전용 ultra, 옛 none/minimal 등)는 조용히 버리고 qgrid 기본을 쓴다.
    "--effort",
    resolveAnthropicEffort(opts.effort) ?? ANTHROPIC_DEFAULT_EFFORT,
    "--disable-slash-commands",
    "--session-id",
    opts.sessionId,
  ];
  if (useStructured) args.push("--json-schema", opts.jsonSchema!);
  return args;
}

/**
 * Claude 세션을 spawn 해 한 turn 을 실행한다. per-session 락으로 직렬화된다.
 * @param onDelta 점진 텍스트 delta(streamText) 또는 structured 부분 JSON(streamObject).
 */
export function runClaudeSession(
  req: ClaudeSessionRequest,
  onDelta: (text: string) => void,
): Promise<ClaudeSessionResult> {
  // 정규화 규칙은 canonicalAnthropicModel 이 단독 소유 — dispatcher 가 이미 canonical 을 넘기지만,
  // 직접 호출(테스트/미래 caller) 대비 방어적으로 한 번 더 통과시킨다(이미 canonical 이면 no-op).
  assertSupportedOneMillionSuffix(req.model);
  const model = canonicalAnthropicModel(req.model);
  const supportsOneMillion = supports1MContext(model);
  const needsOneMillionSuffix = needsCli1mSuffix(model);
  const sessionId = randomUUID();
  const useStructured = Boolean(req.jsonSchema && req.jsonSchema.length > 0);
  const workerId = makeAnthropicWorkerId(req.tokenId);

  return withSessionLock(sessionId, () => {
    ensureCwd();
    const configDir = ensureConfigDir(req.tokenId);

    // 시스템 프롬프트를 크기로 분기: 128KB(argv 한계)의 절반을 넘으면 파일로 넘겨 E2BIG 회피.
    // 작은 프롬프트는 파일 I/O 없이 기존 inline 경로를 그대로 쓴다(대부분의 호출).
    // 실제 파일 쓰기는 abort 체크 이후(Promise 안)로 미뤄, 이미 취소된 요청엔 쓰지 않는다.
    const system = req.system ?? "";
    const useSystemPromptFile = Buffer.byteLength(system, "utf8") > SYSTEM_PROMPT_ARGV_MAX_BYTES;
    const systemPromptFile = useSystemPromptFile
      ? `${configDir}/system-prompt-${sessionId}.txt`
      : undefined;

    const args = buildClaudeArgs({
      model,
      system: useSystemPromptFile ? undefined : req.system,
      systemPromptFile,
      effort: req.effort,
      jsonSchema: req.jsonSchema,
      sessionId,
      needsOneMillionSuffix,
      includePartialMessages: req.includePartialMessages,
    });

    const inputLines = buildStreamJsonInput({
      coldHistory: req.coldHistory,
      input: req.input,
    });
    const stdinPayload = decorateAndSerialize(inputLines, sessionId);

    return new Promise<ClaudeSessionResult>((resolve, reject) => {
      if (req.abortSignal?.aborted) {
        reject(new Error("aborted"));
        return;
      }

      // 대형 시스템 프롬프트는 spawn 직전에 파일로 기록(argv E2BIG 회피). 종료 시 정리한다.
      if (systemPromptFile) writeFileSync(systemPromptFile, system);

      const child = spawn("claude", args, {
        // stderr 도 캡처: invalid OAuth / 잘못된 플래그 / CLI 검증 실패가
        // "closed without result" 로 뭉개지지 않게 close/error 에 stderr 를 실어 보낸다.
        stdio: ["pipe", "pipe", "pipe"],
        cwd: ANTHROPIC_CLAUDE_CWD,
        env: {
          PATH: process.env.PATH,
          TMPDIR: process.env.TMPDIR,
          CLAUDE_CODE_OAUTH_TOKEN: req.token,
          CLAUDE_CONFIG_DIR: configDir,
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
          ...thinkingEnv(model),
          ...oneMillionEnv(supportsOneMillion),
          CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
          CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
          CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1",
          CLAUDE_CODE_DISABLE_WORKFLOWS: "1",
          CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
          // structured + 스트리밍일 때만 retry 를 고정한다(SON-495). text 모드와 논스트림
          // generate 는 CC 기본 retry 를 그대로 쓴다.
          ...(shouldPinStructuredRetries({
            useStructured,
            includePartialMessages: req.includePartialMessages,
          })
            ? structuredOutputRetriesEnv()
            : {}),
        },
      });

      let settled = false;
      let buffer = "";
      const streamState: ClaudeStreamJsonState = {};
      const ttftTracker = createTtftTracker();
      const onTrackedDelta = ttftTracker.wrapDelta(onDelta);
      // bounded stderr 버퍼(최근 ~4KB만 유지 — 무한 누적 방지).
      let stderrBuf = "";
      const STDERR_CAP = 4096;
      child.stderr?.on("data", (d: Buffer) => {
        stderrBuf = (stderrBuf + d.toString()).slice(-STDERR_CAP);
      });
      const stderrSuffix = () => (stderrBuf.trim() ? ` — stderr: ${stderrBuf.trim()}` : "");
      // spawn 시 쓴 임시 시스템 프롬프트 파일 정리(한 번만). 모든 종료 경로에서 호출한다.
      // 누락돼도 다음 ensureConfigDir 가 디렉토리를 재사용할 뿐이지만, sessionId 별 파일이라
      // 쌓이면 디스크가 차므로 settle 시 즉시 지운다.
      const cleanupSpawnFiles = () => {
        if (!systemPromptFile) return;
        try {
          unlinkSync(systemPromptFile);
        } catch {
          // 이미 없거나 권한 문제면 무시 — 정리는 best-effort.
        }
      };
      let cleanupAbort: (() => void) | undefined;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanupAbort?.();
        cleanupSpawnFiles();
        child.kill();
        reject(new Error(`Claude session timeout after ${req.timeoutMs / 1000}s`));
      }, req.timeoutMs);

      const finish = (result: ClaudeStreamResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanupAbort?.();
        cleanupSpawnFiles();
        resolve({ ...result, sessionId, workerId, ttftMs: ttftTracker.value() });
      };

      const onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanupAbort?.();
        cleanupSpawnFiles();
        child.kill();
        reject(new Error("aborted"));
      };
      cleanupAbort = () => req.abortSignal?.removeEventListener("abort", onAbort);
      req.abortSignal?.addEventListener("abort", onAbort, { once: true });

      child.stdout?.on("data", (d: Buffer) => {
        if (settled) return;
        buffer += d.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const result = handleStreamJsonLine(line, onTrackedDelta, {
            structuredOutput: useStructured,
            state: streamState,
          });
          if (result) {
            finish(result);
            return;
          }
        }
      });

      child.on("close", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanupAbort?.();
        cleanupSpawnFiles();
        reject(new Error(`Claude session closed without result${stderrSuffix()}`));
      });
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanupAbort?.();
        cleanupSpawnFiles();
        reject(new Error(`Claude session spawn error: ${err.message}`));
      });

      // stdin 으로 입력 JSONL 흘리고 닫는다.
      ttftTracker.markStart();
      child.stdin?.write(stdinPayload);
      child.stdin?.end();
    });
  });
}

// usage 재노출(테스트 편의).
export type { TokenUsageBreakdown };
