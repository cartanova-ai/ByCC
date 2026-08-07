import path from "path";

import { getConsoleSink } from "@logtape/logtape";
import { getLogger } from "@logtape/logtape";
import { getPrettyFormatter } from "@logtape/pretty";
import { CachePresets, defineConfig } from "sonamu";
import { drivers as cacheDrivers, store } from "sonamu/cache";

import { monitLogSink } from "./application/monit/log-buffer";
import {
  startExpiredTokenReminder,
  stopExpiredTokenReminder,
} from "./application/qgrid/expired-token-reminder";
import { QgridDispatcher } from "./application/qgrid/qgrid.dispatcher";
import { QgridFrame } from "./application/qgrid/qgrid.frame";
import { TokenSubscriber } from "./application/qgrid/token-subscriber";
import { ensureTokensTrigger } from "./application/qgrid/token-trigger-setup";
import { handleServerError } from "./server-error-handler";
import { AnthropicDispatcher } from "./utils/providers/anthropic/anthropic-dispatcher";
import { OpenAIDispatcher } from "./utils/providers/openai/openai-dispatcher";

const host = process.env.HOST ?? "localhost";
const port = Number(process.env.PORT ?? 44900);

const connConfig = {
  host: process.env.SONAMU_DB_HOST ?? "localhost",
  port: Number(process.env.SONAMU_DB_PORT ?? 5432),
  user: process.env.SONAMU_DB_USER ?? "postgres",
  password: process.env.SONAMU_DB_PASSWORD ?? "postgres",
  database: process.env.SONAMU_DB_NAME ?? "qgrid",
};

export default defineConfig({
  projectName: process.env.PROJECT_NAME ?? "Qgrid",
  database: {
    defaultOptions: {
      connection: {
        ...connConfig,
        keepAlive: true,
        keepAliveInitialDelayMillis: 10000,
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
      // Monit 탭용 in-memory ring buffer. 포맷은 sink 별 — 콘솔 출력은 그대로다.
      monit: monitLogSink,
    },
    loggers: [
      // qgrid 로그 (요청 분배, oauth/usage API)
      { category: ["qgrid"], sinks: ["console", "monit"], lowestLevel: "info" },
      // sonamu 로그는 warning 이상만
      { category: ["sonamu"], sinks: ["console", "monit"], lowestLevel: "warning" },
      // fastify 로그 차단
      { category: ["fastify"], sinks: [], lowestLevel: "fatal" },
    ],
  },
  server: {
    listen: { port, host },
    fastify: {
      bodyLimit: 10 * 1024 * 1024,
    },
    plugins: {
      formbody: true,
      qs: true,
      sse: true,
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
            return QgridFrame.handleOAuthCallback(code, state, reply);
          } catch (e) {
            return reply.redirect(
              `/?oauth=error&reason=${encodeURIComponent((e as Error).message)}`,
            );
          }
        });

        // OpenAI OAuth 는 codex app-server 가 자체 callback 서버를 올림
        // handleOpenAICallback 불필요 — oauthCompleteOpenAI API 로 완료 확인
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
        return CachePresets.noCache;
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
        const log = getLogger(["qgrid", "startup"]);

        let triggerReady = true;
        try {
          await ensureTokensTrigger(connConfig);
        } catch (e) {
          triggerReady = false;
          log.warn(`trigger setup failed: ${(e as Error).message}`);
        }

        const subscriber = new TokenSubscriber(connConfig, QgridDispatcher);
        QgridDispatcher.subscriber = subscriber;

        const started = await subscriber.start();

        // 기동 상태를 남긴다 — HTTP 는 이미 열려 있어서, 준비 전 요청이 "잠시 후 되는지"
        // "재시도해도 안 되는지"를 구분해 응답해야 한다(503 vs 500).
        try {
          const openaiDispatcher = new OpenAIDispatcher();
          await openaiDispatcher.start();
          QgridDispatcher.openaiDispatcher = openaiDispatcher;
          QgridDispatcher.startupState.openai = "ready";
        } catch (e) {
          QgridDispatcher.startupState.openai = "failed";
          log.warn(`openai dispatcher failed: ${(e as Error).message}`);
        }

        try {
          const anthropicDispatcher = new AnthropicDispatcher();
          await anthropicDispatcher.start();
          QgridDispatcher.anthropicDispatcher = anthropicDispatcher;
          QgridDispatcher.startupState.anthropic = "ready";
        } catch (e) {
          QgridDispatcher.startupState.anthropic = "failed";
          log.warn(`anthropic dispatcher failed: ${(e as Error).message}`);
        }

        startExpiredTokenReminder();

        const anthropicCount = QgridDispatcher.anthropicDispatcher?.tokenCount ?? 0;
        const openaiReady = QgridDispatcher.openaiDispatcher?.readyWorkerCount ?? 0;
        const openaiTotal = QgridDispatcher.openaiDispatcher?.workerCount ?? 0;

        log.info(`listening on http://${host}:${port}`);
        log.info(`anthropic: ${anthropicCount} tokens ready`);
        log.info(`openai: ${openaiReady}/${openaiTotal} tokens ready`);
        log.info(
          `subscriber: ${started ? "LISTEN active" : "degraded"}${triggerReady ? "" : ", trigger failed"}`,
        );
      },
      onShutdown: async () => {
        const log = getLogger(["qgrid", "startup"]);
        stopExpiredTokenReminder();
        if (QgridDispatcher.openaiDispatcher) {
          await QgridDispatcher.openaiDispatcher.stop();
        }
        if (QgridDispatcher.anthropicDispatcher) {
          await QgridDispatcher.anthropicDispatcher.stop();
        }
        if (QgridDispatcher.subscriber) {
          await QgridDispatcher.subscriber.stop();
        }
        log.info("graceful shutdown");
      },
      onError: (error, _request, reply) => {
        handleServerError(error, reply);
      },
    },
  },
});
