# CLI, Env, And Server Boot

Use this reference for qgrid startup, configuration, and runtime-facing environment variables.

## CLI options

- `--db <url>`: PostgreSQL URL in `postgres://user:password@host:port/dbname` or `postgresql://...` form. Parsed by `packages/cli/src/cli.ts` as the highest-priority database input.
- `-p, --port <port>`: server port. Default `44900`. The CLI validates the port and refuses to start if it is already in use.
- `--skip-update`: skip qgrid CLI self-update check.

The self-update check is strict: when npm reports a newer `@cartanova/qgrid-cli`, including patch releases, the CLI installs that exact resolved version and restarts from the updated binary. Do not use a moving `@latest` install target for this path; exact versions avoid stale pnpm global project ranges.

The CLI also ensures runtime CLIs are installed/current enough:

- `codex` from `@openai/codex`, required for OpenAI tokens.
- `claude` from `@anthropic-ai/claude-code`, required for Anthropic tokens.

## CLI database env vars

`QGRID_DB_*` is the public database configuration for the packaged qgrid CLI.
Immediately before server boot, the CLI copies the resolved values into
Sonamu's internal `SONAMU_DB_*` variables. `--db` overrides `QGRID_DB_*`;
`QGRID_DB_*` overrides an existing `SONAMU_DB_*` value. The latter remains a
compatibility fallback and should not be the environment contract shown to CLI
users.

| Env | Default | Meaning |
|---|---:|---|
| `QGRID_DB_HOST` | `localhost` | PostgreSQL host. |
| `QGRID_DB_PORT` | `5432` | PostgreSQL port. |
| `QGRID_DB_USER` | `postgres` | PostgreSQL user. |
| `QGRID_DB_PASSWORD` | `postgres` | PostgreSQL password. |
| `QGRID_DB_NAME` | `qgrid` | PostgreSQL database. |

Source deployments that run `packages/api` without the packaged CLI must use
Sonamu's native `SONAMU_DB_HOST`, `SONAMU_DB_PORT`, `SONAMU_DB_USER`,
`SONAMU_DB_PASSWORD`, and `SONAMU_DB_NAME` variables directly.

## Server env vars agents should know

| Env | Default | Meaning |
|---|---:|---|
| `NODE_ENV` | direct API: `development`; packaged CLI: `production` | Sonamu runtime profile. Use `staging` for remote non-production API deployments such as dev0. The profile does not create or rename the explicitly configured DB. |
| `HOST` | `localhost` | Sonamu server listen host when running API directly. |
| `PORT` | `44900` | Sonamu server listen port. In CLI mode this is derived from `--port`, not read as user input. |
| `PROJECT_NAME` | `Qgrid` | Sonamu project name. Not the same as request log `projectName`. |

Do not treat CLI bundle bootstrapping internals as user-facing qgrid configuration.
The packaged CLI accepts only `staging` and `production`; `development` and `test`
require the source workspace. Sonamu 0.10.3 also requires `.env` or
`.env.<NODE_ENV>` to exist at the API root. Source deployments must retain one of
those files, while the npm CLI bundle carries an empty `.env` marker itself.

## SDK/client env vars

| Env | Default | Meaning |
|---|---:|---|
| `QGRID_URL` | `http://localhost:44900` | Server URL used by `@cartanova/qgrid-ai-sdk` and logger integration. |
| `QGRID_PROJECT_NAME` | empty | Request log project name sent by the AI SDK provider/logger unless overridden in config. Configure this in the calling app or agent runtime environment, not only in the qgrid server process. |

When helping a user set up qgrid locally, check for `QGRID_PROJECT_NAME` or config `projectName`. If absent, ask for a stable project/workflow label or add the obvious app/repo name when the setup context makes it unambiguous. This keeps request logs, metrics, and dashboard filters usable once traffic volume grows.

## Provider runtime knobs

| Env | Default | Meaning |
|---|---:|---|
| `QGRID_OPENAI_AUTOSCALE` | enabled | Set to `"false"` or `"0"` to disable demand expansion and scale-down, keeping capacity fixed at the minimum. Fixed-mode health maintenance still replaces missing or terminal workers. |
| `QGRID_OPENAI_MIN_WORKERS_PER_TOKEN` | `1` | Steady-state minimum worker slots maintained for each active OpenAI token. Transient restarts keep their slot; terminal or missing slots are replaced. Clamped to 1..20. |
| `QGRID_OPENAI_MAX_WORKERS_PER_TOKEN` | `3` when autoscaling | Maximum workers per active OpenAI token. It cannot be lower than the resolved minimum and is hard-capped at 20. When autoscaling is disabled, the maximum equals the minimum. |
| `QGRID_OPENAI_SCALE_INTERVAL_MS` | `5000` | OpenAI pool health, idle-thread cleanup, and demand autoscaling evaluation interval. Clamped to 250..300000 ms. |
| `QGRID_OPENAI_SCALE_DOWN_IDLE_MS` | `600000` | Idle time before an excess worker becomes eligible for scale-down. Clamped to 1000 ms..24 hours. |
| `QGRID_OPENAI_MAX_ESTIMATED_RSS_GIB` | `16` | Refuse scale-up when estimated qgrid worker RSS would exceed this value. Estimate: `0.71 + 0.157 * totalWorkerCount` GiB. |
| `QGRID_OPENAI_MIN_HOST_AVAILABLE_GIB` | `20` | Refuse scale-up when current host available memory is below this value. |
| `QGRID_OPENAI_THREAD_REUSE` | enabled | Set to `"false"` to disable OpenAI thread reuse and force cold thread behavior. |
| `MAX_STRUCTURED_OUTPUT_RETRIES` | `1` for structured Anthropic streaming calls | Claude Code structured-output retry count for streaming only, clamped to at least 1 by qgrid. Non-streaming `generate` leaves the variable unset and uses Claude Code's default retry budget. |

## Server boot lifecycle

`packages/api/src/index.ts` runs `bootstrapServer` (`server-bootstrap.ts`) with a strict init → migrate → listen order:

1. The packaged CLI maps public `QGRID_DB_*` inputs to internal `SONAMU_DB_*`, then `Sonamu.init()` loads Sonamu's native dotenv snapshot for the active `NODE_ENV` and reads that internal database connection. Direct source API deployments set `SONAMU_DB_*` themselves. Selecting `staging` alone does not create a staging DB; the explicit database name remains authoritative.
2. `runRequiredMigrations` (`startup-migrations.ts`) applies latest migrations from `packages/api/src/migrations` before the server listens. Migration failure exits the process — qgrid must not boot against a schema missing required columns such as `tokens.weight`. This is a hard-fail; it used to be a soft-fail warn inside `onStart`.
3. `Sonamu.createServer()` starts the server. Its `onStart` in `packages/api/src/sonamu.config.ts`:
   1. Ensures PostgreSQL `tokens_changed` triggers.
   2. Starts `TokenSubscriber` for LISTEN/NOTIFY plus periodic reconcile.
   3. Starts `OpenAIDispatcher` and `AnthropicDispatcher`.
   4. Logs server URL and provider readiness counts.

On shutdown, it stops provider dispatchers and the token subscriber.

### Readiness during startup

HTTP listening opens before the dispatchers finish starting, so requests can arrive while a provider is still unavailable. On dev0 that window is 1–2 minutes: 25 OpenAI workers spawn at `SPAWN_INTERVAL_MS` apart, plus codex process init.

- `QgridDispatcher.startupState` tracks each provider as `starting` → `ready` or `failed`. A request for an unready provider throws `ServiceUnavailableException` (503, with a `Retry-After` header) while starting, and `InternalServerErrorException` (500) once initialization has failed — retrying helps in the first case and never in the second. Both used to be `QuotaError`, which told callers their tokens were exhausted and gave them nothing to act on.
- `GET /api/qgrid/health` reports `ready` plus per-provider state. A 200 alone does not mean requests will succeed; read `providers` for that.
- `handleServerError` trusts `statusCode` only on `instanceof SoException`. Sonamu's own `isSoException` is a `statusCode !== undefined` duck-type check, which would pass upstream fetch errors straight through and echo an upstream 401 as if the caller were unauthorized.

## OAuth callbacks

- Anthropic OAuth: loopback dashboards use `/callback` on the qgrid server (base derived per request from `Origin`, falling back to `X-Forwarded-Host`/`Host`). Remote dashboards cannot use a public callback (client redirect-URI allowlist), so `oauthStart` returns `mode: "code"` with the console callback and the user pastes the shown `code#state` into the dashboard (`oauthComplete`). No env configuration either way; direct non-HTTP calls fall back to localhost and `PORT`.
- OpenAI OAuth is handled by Codex app-server's own callback flow and completed through qgrid's OpenAI OAuth APIs.
