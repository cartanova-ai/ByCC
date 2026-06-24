/**
 * claude-session — Claude CLI 세션 spawn + QgridThreadCoord 매핑 + per-session 락.
 *
 * 멀티턴: 첫 호출 `--session-id <uuid>`, 후속 `--resume <uuid>`. 입력은 U2 어댑터가 만든
 * JSONL 을 stdin 으로 흘리고(`--input-format stream-json`), 출력은 U3 파서로 처리한다.
 *
 * 핵심 계약:
 *  - coord 는 임의 저장이 아니라 기존 QgridThreadCoord{workerId,threadId,epoch,systemHash} 에
 *    매핑한다. threadId=세션 uuid, epoch=0 고정(worker restart 개념 없음), workerId=token 기반
 *    안정 합성, systemHash=요청 system 해시. issueConvContext/decideConvRouting 과 round-trip.
 *  - resume eligibility 는 systemHash 만으로 부족 → 확장 호환키(system+model+structured 모드)로
 *    판정. 불일치면 cold fallback.
 *  - 같은 세션의 동시 turn 은 per-session 락(session-id 단위 직렬화)으로 transcript 오염 방지.
 *  - stream-json 직렬화 시 SDK envelope(uuid/session_id/parent_tool_use_id) decorate.
 *  - structured output 일 때 출력 파서에 { structuredOutput: true } 전달(없으면 streamObject 깨짐).
 *
 * ⚠️ 첫 호출 동시성: resume 가 아닌 "첫 호출"은 여기서 새 랜덤 session-id 를 발급하므로, 같은
 *    qgrid sessionKey 에 대한 두 동시 첫 호출은 서로 다른 id 로 둘 다 실행된다. 현재 IF/owner scope 는
 *    LLM 호출을 순차 실행하고 sessionKey 를 서버로 보내지 않으므로, dispatcher 는 cold 락을 두지 않는다.
 *    병렬 첫 호출을 서버가 지원하게 되면 sessionKey 전달/락 설계부터 다시 잡아야 한다.
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

import { type JsonValue } from "../../../codex-protocol/serde_json/JsonValue";
import { type TokenUsageBreakdown } from "../../../codex-protocol/v2/TokenUsageBreakdown";
import { type UserInput } from "../../../codex-protocol/v2/UserInput";
import {
  ANTHROPIC_CLAUDE_CWD,
  anthropicConfigDir,
  ANTHROPIC_DEFAULT_EFFORT,
  ANTHROPIC_DISALLOWED_TOOLS,
  assertSupportedOneMillionSuffix,
  canonicalAnthropicModel,
  needsCli1mSuffix,
  supports1MContext,
} from "./anthropic-constants";
import {
  buildStreamJsonInput,
  type ClaudeStreamJsonState,
  type ClaudeStreamJsonLine,
  type ClaudeStreamResult,
  handleStreamJsonLine,
} from "./stream-json-adapter";

// ── 호환키 ──────────────────────────────────────────────────────────

// resume 가능 여부를 가르는 키. systemHash 만으로는 같은 sessionKey 를 다른 model/schema 로
// 재사용할 때 context 오염 → system + model + structured 모드까지 묶는다.
export function compatibilityKey(opts: {
  system?: string;
  model: string;
  // structured output schema 문자열. 없으면 text 모드. 내용이 다르면 다른 키.
  outputSchema?: string;
}): string {
  const schemaPart = opts.outputSchema && opts.outputSchema.length > 0 ? opts.outputSchema : "text";
  return createHash("sha256")
    .update(`${opts.system ?? ""}\0${opts.model}\0${schemaPart}`)
    .digest("hex")
    .slice(0, 16);
}

// ── per-session 락 ─────────────────────────────────────────────────

// session-id 단위 직렬화. 같은 세션의 동시 turn 이 같은 transcript 에 동시 resume·append 하는 것 방지.
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
  // 입력: cold(coldHistory+coldInput) 또는 resume(reuseInput).
  coldHistory?: Array<JsonValue>;
  input: Array<UserInput>;
  // resume 경로면 기존 session-id, cold 면 undefined(새로 발급).
  resumeSessionId?: string;
  abortSignal?: AbortSignal;
  includePartialMessages?: boolean;
}

export interface ClaudeSessionResult extends ClaudeStreamResult {
  sessionId: string;
  workerId: number;
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

export function buildClaudeArgs(opts: {
  model: string;
  system?: string;
  effort?: string;
  jsonSchema?: string;
  sessionId: string;
  isResume: boolean;
  needsOneMillionSuffix?: boolean;
  includePartialMessages?: boolean;
}): Array<string> {
  const useStructured = Boolean(opts.jsonSchema && opts.jsonSchema.length > 0);
  // --tools "" 로 전체 차단, structured(jsonSchema 있음) 면 StructuredOutput 만 허용.
  const toolArgs = useStructured
    ? ["--tools", "", "--allowed-tools", "StructuredOutput"]
    : ["--tools", ""];

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
    "--max-turns",
    useStructured ? "2" : "1",
    "--permission-mode",
    "bypassPermissions",
    "--setting-sources",
    "project",
    "--model",
    applyOneMillionSuffix(opts.model, opts.needsOneMillionSuffix ?? false),
    // inline [System] 금지 — 정식 채널만(R7). 생략 시 CC default(23k) 주입되므로 반드시 명시.
    "--system-prompt",
    opts.system ?? "",
    "--thinking",
    "disabled",
    "--effort",
    opts.effort ?? ANTHROPIC_DEFAULT_EFFORT,
    "--disable-slash-commands",
    // 멀티턴: 첫 호출은 session-id 발급, 후속은 resume. --no-session-persistence 는 쓰지 않는다.
    ...(opts.isResume ? ["--resume", opts.sessionId] : ["--session-id", opts.sessionId]),
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
  const isResume = Boolean(req.resumeSessionId);
  const sessionId = req.resumeSessionId ?? randomUUID();
  const useStructured = Boolean(req.jsonSchema && req.jsonSchema.length > 0);
  const workerId = makeAnthropicWorkerId(req.tokenId);

  return withSessionLock(sessionId, () => {
    ensureCwd();
    const configDir = ensureConfigDir(req.tokenId);

    const args = buildClaudeArgs({
      model,
      system: req.system,
      effort: req.effort,
      jsonSchema: req.jsonSchema,
      sessionId,
      isResume,
      needsOneMillionSuffix,
      includePartialMessages: req.includePartialMessages,
    });

    const inputLines = buildStreamJsonInput({
      coldHistory: req.coldHistory,
      input: req.input,
      isResume,
    });
    const stdinPayload = decorateAndSerialize(inputLines, sessionId);

    return new Promise<ClaudeSessionResult>((resolve, reject) => {
      if (req.abortSignal?.aborted) {
        reject(new Error("aborted"));
        return;
      }

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
          CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "1",
          ...oneMillionEnv(supportsOneMillion),
          CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
          CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
        },
      });

      let settled = false;
      let buffer = "";
      const streamState: ClaudeStreamJsonState = {};
      // bounded stderr 버퍼(최근 ~4KB만 유지 — 무한 누적 방지).
      let stderrBuf = "";
      const STDERR_CAP = 4096;
      child.stderr?.on("data", (d: Buffer) => {
        stderrBuf = (stderrBuf + d.toString()).slice(-STDERR_CAP);
      });
      const stderrSuffix = () => (stderrBuf.trim() ? ` — stderr: ${stderrBuf.trim()}` : "");
      let cleanupAbort: (() => void) | undefined;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanupAbort?.();
        child.kill();
        reject(new Error(`Claude session timeout after ${req.timeoutMs / 1000}s`));
      }, req.timeoutMs);

      const finish = (result: ClaudeStreamResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanupAbort?.();
        resolve({ ...result, sessionId, workerId });
      };

      const onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanupAbort?.();
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
          const result = handleStreamJsonLine(line, onDelta, {
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
        reject(new Error(`Claude session closed without result${stderrSuffix()}`));
      });
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanupAbort?.();
        reject(new Error(`Claude session spawn error: ${err.message}`));
      });

      // stdin 으로 입력 JSONL 흘리고 닫는다.
      child.stdin?.write(stdinPayload);
      child.stdin?.end();
    });
  });
}

// usage 재노출(테스트 편의).
export type { TokenUsageBreakdown };
