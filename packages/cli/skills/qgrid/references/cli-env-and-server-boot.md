# CLI, Env, And Server Boot

Use this reference for qgrid startup, configuration, and runtime-facing environment variables.

## CLI options

- `--db <url>`: PostgreSQL URL in `postgres://user:password@host:port/dbname` or `postgresql://...` form. Parsed by `packages/cli/src/cli.ts` and copied into `QGRID_DB_*` env vars before server boot.
- `-p, --port <port>`: server port. Default `44900`. The CLI validates the port and refuses to start if it is already in use.
- `--skip-update`: skip qgrid CLI self-update check.

The self-update check is strict: when npm reports a newer `@cartanova/qgrid-cli`, including patch releases, the CLI installs that exact resolved version and restarts from the updated binary. Do not use a moving `@latest` install target for this path; exact versions avoid stale pnpm global project ranges.

The CLI also ensures runtime CLIs are installed/current enough:

- `codex` from `@openai/codex`, required for OpenAI tokens.
- `claude` from `@anthropic-ai/claude-code`, required for Anthropic tokens.

## Server env vars agents should know

| Env | Default | Meaning |
|---|---:|---|
| `QGRID_DB_HOST` | `localhost` | PostgreSQL host. |
| `QGRID_DB_PORT` | `5432` | PostgreSQL port. |
| `QGRID_DB_USER` | `postgres` | PostgreSQL user. |
| `QGRID_DB_PASSWORD` | `postgres` | PostgreSQL password. |
| `QGRID_DB_NAME` | `qgrid` | PostgreSQL database. |
| `HOST` | `localhost` | Sonamu server listen host when running API directly. |
| `PORT` | `44900` | Sonamu server listen port. In CLI mode this is derived from `--port`, not read as user input. |
| `QGRID_PUBLIC_BASE_URL` | empty | Public base URL used to construct Anthropic OAuth callback URL. If unset, callback defaults to `http://localhost:${PORT}/callback`. |
| `PROJECT_NAME` | `Qgrid` | Sonamu project name. Not the same as request log `projectName`. |

Do not treat CLI bundle bootstrapping internals as user-facing qgrid configuration.

## SDK/client env vars

| Env | Default | Meaning |
|---|---:|---|
| `QGRID_URL` | `http://localhost:44900` | Server URL used by `@cartanova/qgrid-ai-sdk` and logger integration. |
| `QGRID_PROJECT_NAME` | empty | Request log project name sent by the AI SDK provider/logger unless overridden in config. Configure this in the calling app or agent runtime environment, not only in the qgrid server process. |

When helping a user set up qgrid locally, check for `QGRID_PROJECT_NAME` or config `projectName`. If absent, ask for a stable project/workflow label or add the obvious app/repo name when the setup context makes it unambiguous. This keeps request logs, metrics, and dashboard filters usable once traffic volume grows.

## Provider runtime knobs

| Env | Default | Meaning |
|---|---:|---|
| `QGRID_WORKERS_PER_TOKEN` | `3` | OpenAI Codex workers per token. Capped at 5 in code. |
| `QGRID_OPENAI_THREAD_REUSE` | enabled | Set to `"false"` to disable OpenAI thread reuse and force cold thread behavior. |
| `MAX_STRUCTURED_OUTPUT_RETRIES` | `1` for structured Anthropic calls | Claude Code structured-output retry count, clamped to at least 1 by qgrid. |

## Server boot lifecycle

On server start, `packages/api/src/sonamu.config.ts`:

1. Loads `.env` from `packages/api/.env` when running API directly.
2. Configures Sonamu database connection from `QGRID_DB_*`.
3. Runs latest migrations from `packages/api/src/migrations`.
4. Ensures PostgreSQL `tokens_changed` triggers.
5. Starts `TokenSubscriber` for LISTEN/NOTIFY plus periodic reconcile.
6. Starts `OpenAIDispatcher` and `AnthropicDispatcher`.
7. Logs server URL and provider readiness counts.

On shutdown, it stops provider dispatchers and the token subscriber.

## OAuth callbacks

- Anthropic OAuth uses `/callback` on the qgrid server. The callback URL is based on `QGRID_PUBLIC_BASE_URL` when set, otherwise localhost and `PORT`.
- OpenAI OAuth is handled by Codex app-server's own callback flow and completed through qgrid's OpenAI OAuth APIs.
