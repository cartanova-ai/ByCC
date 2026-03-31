/**
 * Worker — Claude CLI stream-json 프로세스 하나를 관리.
 *
 * 기존 SocratsAI ClaudeCliService에서 추출 + 리팩터:
 * - 토큰/모델을 생성자에서 주입
 * - env allowlist (PATH, HOME, TMPDIR, CLAUDE_CODE_OAUTH_TOKEN만)
 * - callCount 추적 + maxCalls 도달 시 프로세스 재활용
 * - QuotaError/TimeoutError/ProcessError 구분
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import type { CliResult, QueryInput } from "./bycc.types";
import { maskToken, ProcessError, QuotaError, TimeoutError } from "./bycc.types";

type PendingRequest = {
  resolve: (value: CliResult) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type WorkerConfig = {
  token: string;
  model: string;
  timeout: number;
  cwd: string;
  maxCalls: number;
};

export class Worker {
  tokenId: string;
  config: WorkerConfig;
  process: ChildProcess | null = null;
  buffer = "";
  pending: PendingRequest | null = null;
  sessionId: string | null = null;
  queue: Array<() => void> = [];
  cwdCreated = false;
  callCount = 0;
  needsRecycle = false;

  constructor(config: WorkerConfig) {
    this.config = config;
    this.tokenId = config.token;
  }

  getQueueDepth(): number {
    return this.queue.length + (this.pending ? 1 : 0);
  }

  rejectPending(err: Error): void {
    if (!this.pending) return;
    this.pending.reject(err);
    clearTimeout(this.pending.timer);
    this.pending = null;
  }

  ensureProcess(): ChildProcess {
    if (this.process && this.process.exitCode === null && !this.needsRecycle) {
      return this.process;
    }

    if (this.process && this.process.exitCode === null) {
      this.process.kill();
      this.process = null;
    }

    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      CLAUDE_CODE_OAUTH_TOKEN: this.config.token,
    };

    const { cwd } = this.config;
    if (!this.cwdCreated) {
      mkdirSync(cwd, { recursive: true });
      this.cwdCreated = true;
    }

    const child = spawn(
      "claude",
      [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--max-turns",
        "1",
        "--model",
        this.config.model,
      ],
      { stdio: ["pipe", "pipe", "ignore"], env, cwd },
    );

    child.stdout?.on("data", (d: Buffer) => {
      this.buffer += d.toString();
      this.processBuffer();
    });

    child.on("close", () => {
      this.process = null;
      this.rejectPending(
        new ProcessError(`CLI process closed (token: ${maskToken(this.tokenId)})`),
      );
      this.drainQueue();
    });

    child.on("error", (err) => {
      this.process = null;
      this.rejectPending(
        new ProcessError(`CLI process error: ${err.message} (token: ${maskToken(this.tokenId)})`),
      );
      this.drainQueue();
    });

    this.process = child;
    this.buffer = "";
    this.sessionId = null;
    this.callCount = 0;
    this.needsRecycle = false;
    return child;
  }

  processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    lines
      .filter((line) => line.trim() !== "")
      .forEach((line) => {
        try {
          const j = JSON.parse(line);

          if (j.type === "system" && j.subtype === "init" && j.session_id) {
            this.sessionId = j.session_id;
          }

          if (j.type === "result" && this.pending) {
            let text: string = j.result ?? "";
            text = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");

            if (text.startsWith("You've hit")) {
              this.pending.reject(
                new QuotaError(`Quota exhausted (token: ${maskToken(this.tokenId)})`),
              );
              clearTimeout(this.pending.timer);
              this.pending = null;
              this.drainQueue();
              return;
            }

            const u = j.usage ?? {};
            this.pending.resolve({
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
            clearTimeout(this.pending.timer);
            this.pending = null;
            this.drainQueue();
          }
        } catch {
          // skip non-json lines
        }
      });
  }

  drainQueue(): void {
    if (this.pending) return;
    const next = this.queue.shift();
    if (next) next();
  }

  async query(input: QueryInput, timeoutMs?: number): Promise<CliResult> {
    if (this.pending) {
      await new Promise<void>((resolve) => {
        this.queue.push(resolve);
      });
    }

    const child = this.ensureProcess();
    const timeout = timeoutMs ?? this.config.timeout;

    this.callCount++;
    if (this.callCount >= this.config.maxCalls) {
      this.needsRecycle = true;
    }

    const prompt = input.system ? `${input.system}\n\n${input.prompt}` : input.prompt;

    return new Promise<CliResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(
          new TimeoutError(`Timeout after ${timeout / 1000}s (token: ${maskToken(this.tokenId)})`),
        );
        this.kill();
      }, timeout);

      this.pending = { resolve, reject, timer };

      const msg = JSON.stringify({
        type: "user",
        message: { role: "user", content: prompt },
        session_id: this.sessionId ?? "default",
        parent_tool_use_id: null,
      });

      child.stdin?.write(`${msg}\n`);
    });
  }

  kill(): void {
    if (this.process && this.process.exitCode === null) {
      this.process.kill();
    }
    this.process = null;
    this.buffer = "";
    this.sessionId = null;
    this.callCount = 0;
    this.needsRecycle = false;
    this.rejectPending(new ProcessError(`Worker killed (token: ${maskToken(this.tokenId)})`));
    this.drainQueue();
  }
}
