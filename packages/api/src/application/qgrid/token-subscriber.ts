/** tokens_changed LISTEN subscriber. */
import { getLogger } from "@logtape/logtape";
import { Client, type ClientConfig } from "pg";

import { TokenModel } from "../token/token.model";
import { type AnthropicCredentials, type OpenAICredentials } from "../token/token.types";
import { type QgridDispatcherClass } from "./qgrid.dispatcher";
import { type SubscriberStatus } from "./qgrid.types";

const logger = getLogger(["qgrid", "subscriber"]);

const TOKENS_CHANGED = "tokens_changed";
const RECONCILE_INTERVAL_MS = 10 * 60 * 1000;
const CONNECTION_TIMEOUT_MS = 5_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 30_000;

type Payload = { op: "INSERT" | "UPDATE" | "DELETE"; id: number };

export class TokenSubscriber {
  client: Client | null = null;
  reconcileTimer: NodeJS.Timeout | null = null;
  reconnectTimer: NodeJS.Timeout | null = null;
  shutdownRequested = false;
  attempt = 0;
  connectedAt: Date | null = null;
  lastReconcileAt: Date | null = null;

  constructor(
    public connConfig: ClientConfig,
    public dispatcher: QgridDispatcherClass,
  ) {}

  async start(): Promise<boolean> {
    this.shutdownRequested = false;
    this.ensureReconcileTimer();

    try {
      await this.connectAndReconcile();
      return true;
    } catch (e) {
      logger.warn(`subscriber start failed: ${(e as Error).message}, scheduling retry`);
      this.retryLater();
      return false;
    }
  }

  async stop(): Promise<void> {
    this.shutdownRequested = true;
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this.closeClient();
  }

  status(): SubscriberStatus {
    return {
      connected: this.client !== null && this.reconnectTimer === null,
      connectedAt: this.connectedAt,
      lastReconcileAt: this.lastReconcileAt,
      attempt: this.attempt,
    };
  }

  ensureReconcileTimer(): void {
    if (this.reconcileTimer) return;

    // LISTEN/NOTIFY 는 끊긴 동안 유실될 수 있어 주기적으로 DB 기준으로 맞춘다.
    this.reconcileTimer = setInterval(() => {
      this.reconcile().catch((e) =>
        logger.warn(`periodic reconcile failed: ${(e as Error).message}`),
      );
    }, RECONCILE_INTERVAL_MS);
  }

  async connectAndReconcile(): Promise<void> {
    await this.connectAndListen();
    await this.reconcile();
    this.attempt = 0;
  }

  async connectAndListen(): Promise<void> {
    const client = new Client({
      ...this.connConfig,
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      application_name: "qgrid-listener",
    });

    client.on("error", (e) => {
      logger.warn(`subscriber error: ${e.message}`);
      this.retryLater();
    });
    client.on("end", () => {
      if (!this.shutdownRequested) this.retryLater();
    });
    client.on("notification", (msg) => {
      if (msg.channel !== TOKENS_CHANGED || !msg.payload) return;
      this.handleNotification(msg.payload).catch((e) =>
        logger.warn(`handle NOTIFY failed: ${(e as Error).message}`),
      );
    });

    try {
      await client.connect();
      await client.query("SET statement_timeout = 0");
      await client.query("SET idle_in_transaction_session_timeout = 0");
      await client.query(`LISTEN ${client.escapeIdentifier(TOKENS_CHANGED)}`);
    } catch (e) {
      client.removeAllListeners();
      await client.end().catch(() => {});
      throw e;
    }

    this.client = client;
    this.connectedAt = new Date();
    logger.info(`subscribed to ${TOKENS_CHANGED}`);
  }

  retryLater(): void {
    if (this.shutdownRequested) return;
    if (this.reconnectTimer) return;

    void this.closeClient();
    this.attempt += 1;
    const cap = Math.min(BACKOFF_BASE_MS * 2 ** this.attempt, BACKOFF_CAP_MS);
    const delay = Math.floor(Math.random() * cap);
    logger.info(`reconnecting in ${delay}ms (attempt ${this.attempt})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectAndReconcile().catch((e) => {
        logger.warn(`subscriber reconnect failed: ${(e as Error).message}`);
        this.retryLater();
      });
    }, delay);
  }

  async closeClient(): Promise<void> {
    const client = this.client;
    if (!client) return;

    this.client = null;
    client.removeAllListeners();
    await client.end().catch(() => {});
  }

  async handleNotification(payloadJson: string): Promise<void> {
    const payload = JSON.parse(payloadJson) as Payload;
    if (payload.op === "DELETE") {
      this.dispatcher.removeCache(payload.id);
      this.dispatcher.openaiDispatcher
        ?.onTokenRemoved(payload.id)
        .catch((e) => logger.warn(`openai worker remove failed: ${(e as Error).message}`));
      // anthropic 토큰 이벤트는 동기(void) — provider 를 모르므로 무해하게 항상 제거 시도.
      this.dispatcher.anthropicDispatcher?.onTokenRemoved(payload.id);
      logger.info(`NOTIFY ${payload.op} id=${payload.id} → removed from cache`);
      return;
    }
    const row = await TokenModel.findOne("A", { id: payload.id });
    if (!row) {
      this.dispatcher.removeCache(payload.id);
      this.dispatcher.openaiDispatcher
        ?.onTokenRemoved(payload.id)
        .catch((e) => logger.warn(`openai worker remove failed: ${(e as Error).message}`));
      this.dispatcher.anthropicDispatcher?.onTokenRemoved(payload.id);
      logger.info(`NOTIFY ${payload.op} id=${payload.id} → missing, removed from cache`);
      return;
    }

    this.dispatcher.upsertCache(payload.id, row);

    if (row.provider === "openai") {
      const creds = row.credentials as Record<string, unknown>;
      const openaiDispatcher = this.dispatcher.openaiDispatcher;
      if (payload.op === "INSERT" && row.active) {
        openaiDispatcher
          ?.onTokenAdded(payload.id, row.name, creds as OpenAICredentials, row.quota_threshold)
          .catch((e) => logger.warn(`openai worker spawn failed: ${(e as Error).message}`));
      } else if (row.active) {
        if (openaiDispatcher) {
          openaiDispatcher
            .onTokenUpdated(payload.id, row.name, creds as OpenAICredentials, row.quota_threshold)
            .then(() => openaiDispatcher.onTokenActivated(payload.id))
            .catch((e) => logger.warn(`openai worker update failed: ${(e as Error).message}`));
        }
      } else {
        openaiDispatcher?.onTokenDeactivated(payload.id);
      }
    } else if (row.provider === "anthropic") {
      // anthropic 토큰 이벤트는 동기(void). worker 가 없고 풀(Map)만 관리하므로 단순:
      //  INSERT → 추가, active 면 갱신(onTokenUpdated 가 identity 변경도 처리), inactive 면 풀에서 제거.
      //  (별도 activate/deactivate 콜백이 없어 active 토글을 add/remove 로 매핑.)
      const creds = row.credentials as AnthropicCredentials;
      if (payload.op === "INSERT" && row.active) {
        this.dispatcher.anthropicDispatcher?.onTokenAdded(
          payload.id,
          row.name,
          creds,
          row.quota_threshold,
        );
      } else if (row.active) {
        this.dispatcher.anthropicDispatcher?.onTokenUpdated(
          payload.id,
          row.name,
          creds,
          row.quota_threshold,
        );
      } else {
        // inactive 면 INSERT 든 UPDATE 든 풀에 넣지 않는다.
        this.dispatcher.anthropicDispatcher?.onTokenRemoved(payload.id);
      }
    }
    logger.info(`NOTIFY ${payload.op} id=${payload.id} (${row.name}) active=${row.active}`);
  }

  async reconcile(): Promise<void> {
    const rows = await TokenModel.findActive("A");
    this.dispatcher.replaceCache(rows);
    // NOTIFY 유실 대비: AnthropicDispatcher 풀도 DB active anthropic 토큰 기준으로 재동기화.
    // (rows 는 active 만 — inactive/삭제된 토큰은 여기 없으므로 replaceTokens 가 풀에서 제거한다.)
    const anthropicRows = rows
      .filter((r) => r.provider === "anthropic")
      .map((r) => ({
        id: r.id,
        name: r.name,
        credentials: r.credentials as AnthropicCredentials,
        quotaThreshold: r.quota_threshold,
      }));
    this.dispatcher.anthropicDispatcher?.replaceTokens(anthropicRows);
    const openaiRows = rows
      .filter((r) => r.provider === "openai")
      .map((r) => ({
        id: r.id,
        name: r.name,
        credentials: r.credentials as OpenAICredentials,
        quotaThreshold: r.quota_threshold,
      }));
    await this.dispatcher.openaiDispatcher
      ?.replaceTokens(openaiRows)
      .catch((e) => logger.warn(`openai reconcile failed: ${(e as Error).message}`));
    this.lastReconcileAt = new Date();
  }
}
