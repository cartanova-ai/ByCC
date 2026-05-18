import path from "path";

import { getConsoleSink } from "@logtape/logtape";
import { getPrettyFormatter } from "@logtape/pretty";
import dotenv from "dotenv";
import { CachePresets, defineConfig } from "sonamu";
import { drivers as cacheDrivers, store } from "sonamu/cache";

import { QgridFrame } from "./application/qgrid/qgrid.frame";

dotenv.config({ path: path.join(import.meta.dirname, "../.env") });

const host = process.env.HOST ?? "localhost";
const port = Number(process.env.PORT ?? 44900);

const connConfig = {
  // host: process.env.QGRID_DB_HOST ?? "localhost",
  // port: Number(process.env.QGRID_DB_PORT ?? 5432),
  // user: process.env.QGRID_DB_USER ?? "postgres",
  // password: process.env.QGRID_DB_PASSWORD ?? "postgres",
  // database: process.env.QGRID_DB_NAME ?? "qgrid",
  host: "localhost",
  port: 5432,
  user: "postgres",
  password: "postgres",
  database: "qgrid",
};

export default defineConfig({
  projectName: process.env.PROJECT_NAME ?? "SonamuProject",
  database: {
    name: "qgrid",
    defaultOptions: {
      connection: {
        ...connConfig,
        keepAlive: true,
        keepAliveInitialDelayMillis: 10000,
      },
    },
    environments: {
      fixture: {
        connection: {
          ...connConfig,
          database: process.env.QGRID_DB_NAME,
        },
      },
    },
  },
  api: {
    dir: "api",
    timezone: "Asia/Seoul",
    route: {
      prefix: "/api",
    },
  },
  i18n: {
    defaultLocale: "ko",
    supportedLocales: ["ko", "en"],
  },
  sync: {
    targets: ["web"],
  },
  slackConfirm:
    process.env.SLACK_BOT_TOKEN && process.env.SLACK_CHANNEL_ID
      ? {
          targets: ["development_master", "production_master"],
          botToken: process.env.SLACK_BOT_TOKEN ?? "",
          channelId: process.env.SLACK_CHANNEL_ID ?? "",
        }
      : undefined,
  test: {
    parallel: true,
    maxWorkers: 4,
    devRunner: { enabled: true },
  },
  logging: {
    sinks: {
      console: getConsoleSink({
        formatter: getPrettyFormatter({
          timestamp: "time",
          categoryWidth: 20,
          categoryTruncate: "middle",
        }),
      }),
    },
    loggers: [
      // qgrid 로그 (요청 분배, oauth/usage API)
      { category: ["qgrid"], sinks: ["console"], lowestLevel: "info" },
      // sonamu 로그는 warning 이상만
      { category: ["sonamu"], sinks: ["console"], lowestLevel: "warning" },
      // fastify 로그 차단
      { category: ["fastify"], sinks: [], lowestLevel: "fatal" },
    ],
  },
  server: {
    listen: { port, host },
    plugins: {
      formbody: true,
      qs: true,
      multipart: { limits: { fileSize: 1024 * 1024 * 30 } },
      static: {
        root: path.join(import.meta.dirname, "/../", "public"),
        prefix: "/api/public",
      },
      custom: (server) => {
        // OAuth 콜백 — Anthropic이 /callback으로 리다이렉트
        server.get("/callback", async (request, reply) => {
          const { code, state } = request.query as { code?: string; state?: string };
          if (!code || !state) {
            return reply.redirect("/?oauth=error&reason=missing_params");
          }
          try {
            await QgridFrame.handleOAuthCallback(code, state, reply);
          } catch (e) {
            return reply.redirect(
              `/?oauth=error&reason=${encodeURIComponent((e as Error).message)}`,
            );
          }
        });

        // OAuth 콜백 — OpenAI /callback/openai로 리다이렉트
        server.get("/callback/openai", async (request, reply) => {
          const { code, state } = request.query as { code?: string; state?: string };
          if (!code || !state) {
            return reply.redirect("/?oauth=error&reason=missing_params");
          }
          try {
            await QgridFrame.handleOpenAICallback(code, state, reply);
          } catch (e) {
            return reply.redirect(
              `/?oauth=error&reason=${encodeURIComponent((e as Error).message)}`,
            );
          }
        });
      },
    },
    apiConfig: {
      contextProvider: (defaultContext, request) => {
        return {
          ...defaultContext,
          ip: request.ip,
          body: request.body,
        };
      },
      guardHandler: () => {},
      cacheControlHandler: (req) => {
        switch (req.type) {
          case "assets":
            // Hash 포함된 파일: 영구 캐시
            if (req.path.match(/-[a-f0-9]+\./)) {
              return CachePresets.immutable;
            }
            return CachePresets.longLived;

          case "api":
            // GET 요청만 캐싱 고려
            if (req.method === "GET") {
              // 특정 경로는 짧은 캐시
              if (req.path.startsWith("/api/static-data")) {
                return CachePresets.shortLived;
              }
              if (req.path.startsWith("/api/terms")) {
                return CachePresets.mediumLived;
              }
            }
            // 기본: 캐시 없음
            return CachePresets.noCache;

          case "ssr":
            // SSR 페이지: 10초 캐시
            return CachePresets.ssr;

          case "csr":
            // CSR fallback (index.html): 1분 캐시
            return CachePresets.shortLived;
        }
      },
    },
    cache: {
      default: "main",
      stores: {
        main: store().useL1Layer(cacheDrivers.memory({ maxSize: "50mb" })),
      },
      ttl: "5m",
      prefix: "",
    },
    lifecycle: {
      onStart: async () => {
        // DB 마이그레이션 자동 실행 (테이블 없으면 생성)
        try {
          const { TokenModel } = await import("./application/token/token.model");
          const knex = TokenModel.getDB("w");
          const migrationsDir = path.join(import.meta.dirname, "../src/migrations");
          const [batch, log] = await knex.migrate.latest({
            directory: migrationsDir,
          });
          if (log.length > 0) {
            console.log(`✓ Migration: ${log.length} applied (batch ${batch})`);
            log.forEach((name: string) => console.log(`  ✓ ${name}`));
          }
        } catch (e) {
          console.warn(`⚠ Migration skipped: ${(e as Error).message}`);
        }

        const { QgridDispatcher } = await import("./application/qgrid/qgrid.dispatcher");
        const { ensureTokensTrigger } = await import("./application/qgrid/token-trigger-setup");
        const { TokenSubscriber } = await import("./application/qgrid/token-subscriber");

        let triggerReady = true;
        try {
          await ensureTokensTrigger(connConfig);
        } catch (e) {
          triggerReady = false;
          console.warn(
            `⚠ Token trigger setup failed: ${(e as Error).message}. Continuing with LISTEN/reconcile.`,
          );
        }

        const subscriber = new TokenSubscriber(connConfig, QgridDispatcher);
        QgridDispatcher.subscriber = subscriber;

        const started = await subscriber.start();

        // OpenAI dispatcher (codex app-server worker pool)
        try {
          const { OpenAIDispatcher } = await import("./utils/providers/openai/openai-dispatcher");
          const openaiDispatcher = new OpenAIDispatcher();
          await openaiDispatcher.start();
          QgridDispatcher.openaiDispatcher = openaiDispatcher;
          console.log(`✓ OpenAI dispatcher: ${openaiDispatcher.readyWorkerCount} workers ready`);
        } catch (e) {
          console.warn(`⚠ OpenAI dispatcher failed: ${(e as Error).message}`);
        }

        const tokenInfo = started
          ? `${QgridDispatcher.tokens.size} active tokens, LISTEN active`
          : `degraded — token sync retry scheduled`;
        const triggerInfo = triggerReady ? "" : ", trigger setup failed";
        console.log(`🌲 Server listening on http://${host}:${port} (${tokenInfo}${triggerInfo})`);
      },
      onShutdown: async () => {
        const { QgridDispatcher } = await import("./application/qgrid/qgrid.dispatcher");
        if (QgridDispatcher.openaiDispatcher) {
          await QgridDispatcher.openaiDispatcher.stop();
        }
        if (QgridDispatcher.subscriber) {
          await QgridDispatcher.subscriber.stop();
        }
        console.log("graceful shutdown");
      },
      onError: (error, _request, reply) => {
        console.error(error);
        reply.status(500).send({
          name: error.name,
          message: error.message,
        });
      },
    },
  },
});
