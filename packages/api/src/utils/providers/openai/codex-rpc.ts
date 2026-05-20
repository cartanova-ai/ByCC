/**
 * Codex App-Server stdio JSON-RPC 2.0 클라이언트.
 *
 * - request/response 매칭 (id 기반)
 * - server-request 핸들러 등록 (codex → qgrid 방향)
 * - notification 핸들러
 * - EventEmitter 기반 메시지 분류
 */
import { type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

import { getLogger } from "@logtape/logtape";

import { type AccountLoginCompletedNotification } from "../../../codex-protocol/v2/AccountLoginCompletedNotification";
import { type AgentMessageDeltaNotification } from "../../../codex-protocol/v2/AgentMessageDeltaNotification";
import { type ErrorNotification } from "../../../codex-protocol/v2/ErrorNotification";
import { type ItemCompletedNotification } from "../../../codex-protocol/v2/ItemCompletedNotification";
import { type ThreadTokenUsageUpdatedNotification } from "../../../codex-protocol/v2/ThreadTokenUsageUpdatedNotification";
import { type TurnCompletedNotification } from "../../../codex-protocol/v2/TurnCompletedNotification";

const logger = getLogger(["qgrid", "codex-rpc"]);

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

// ── Types ───────────────────────────────────────────────────────────

export type NotificationMap = {
  "turn/completed": TurnCompletedNotification;
  "item/completed": ItemCompletedNotification;
  "item/agentMessage/delta": AgentMessageDeltaNotification;
  "thread/tokenUsage/updated": ThreadTokenUsageUpdatedNotification;
  error: ErrorNotification;
  "account/login/completed": AccountLoginCompletedNotification;
};

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export class CodexRpcError extends Error {
  constructor(
    public rpcCode: number,
    message: string,
    public rpcData?: unknown,
  ) {
    super(`codex rpc ${rpcCode}: ${message}`);
    this.name = "CodexRpcError";
  }
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type ServerRequestHandler = (params: unknown) => Promise<unknown>;
type NotificationHandler = (params: unknown) => void;

// ── Client ──────────────────────────────────────────────────────────

export class CodexRpcClient {
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private serverRequestHandlers = new Map<string, ServerRequestHandler>();
  private notificationHandlers = new Map<string, NotificationHandler>();
  private rl: Interface;
  private closed = false;

  constructor(private proc: ChildProcess) {
    this.rl = createInterface({ input: proc.stdout! });

    this.rl.on("line", (line) => {
      if (!line.trim()) return;
      this.handleLine(line);
    });

    proc.on("exit", (code) => {
      this.closed = true;
      this.rejectAllPending(new Error(`codex process exited with code ${code}`));
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) logger.debug(`stderr: ${text}`);
    });
  }

  // ── Public API ──────────────────────────────────────────────────

  async request<T = unknown>(
    method: string,
    params: unknown,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    if (this.closed) throw new Error("codex rpc client is closed");

    const id = this.nextId++;
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex rpc timeout: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
        timer,
      });

      this.proc.stdin!.write(msg + "\n");
    });
  }

  onServerRequest(method: string, handler: ServerRequestHandler): void {
    this.serverRequestHandlers.set(method, handler);
  }

  onNotification<M extends keyof NotificationMap>(
    method: M,
    handler: (params: NotificationMap[M]) => void,
  ): void;
  onNotification(method: string, handler: NotificationHandler): void;
  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  destroy(): void {
    this.closed = true;
    this.rl.close();
    this.rejectAllPending(new Error("codex rpc client destroyed"));
  }

  // ── Internal ────────────────────────────────────────────────────

  private handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      logger.debug(`unparseable line: ${line.slice(0, 200)}`);
      return;
    }

    const id = msg.id as number | undefined;
    const method = msg.method as string | undefined;

    // 1. Response to our request
    if (id !== null && id !== undefined && this.pending.has(id)) {
      const p = this.pending.get(id)!;
      this.pending.delete(id);
      clearTimeout(p.timer);

      if (msg.error) {
        const err = msg.error as RpcError;
        p.reject(new CodexRpcError(err.code, err.message, err.data));
      } else {
        p.resolve(msg.result);
      }
      return;
    }

    // 2. Server-request (has method + id, but we didn't send it)
    if (method && id !== null && id !== undefined) {
      this.handleServerRequest(id, method, msg.params);
      return;
    }

    // 3. Notification (has method, no id)
    if (method) {
      this.handleNotification(method, msg.params);
      return;
    }
  }

  private handleServerRequest(id: number, method: string, params: unknown): void {
    const handler = this.serverRequestHandlers.get(method);
    if (!handler) {
      logger.warn(`unhandled server-request: ${method}`);
      this.respondToServerRequest(id, null, {
        code: -32601,
        message: `unhandled: ${method}`,
      });
      return;
    }

    handler(params)
      .then((result) => {
        this.respondToServerRequest(id, result);
      })
      .catch((e) => {
        logger.warn(`server-request handler error (${method}): ${(e as Error).message}`);
        this.respondToServerRequest(id, null, {
          code: -32603,
          message: (e as Error).message,
        });
      });
  }

  private respondToServerRequest(id: number, result: unknown, error?: RpcError): void {
    if (this.closed) return;
    const resp: Record<string, unknown> = { jsonrpc: "2.0", id };
    if (error) {
      resp.error = error;
    } else {
      resp.result = result;
    }
    this.proc.stdin!.write(JSON.stringify(resp) + "\n");
  }

  private handleNotification(method: string, params: unknown): void {
    const handler = this.notificationHandlers.get(method);
    if (handler) {
      handler(params);
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }
}
