# CLI, Env, And Server Boot

Use this reference for qgrid startup, configuration, and runtime-facing environment variables.

## CLI options

- `--db <url>`: PostgreSQL URL in `postgres://user:password@host:port/dbname` or `postgresql://...` form. Parsed by `packages/cli/src/cli.ts` as the highest-priority database input.
- `-p, --port <port>`: server port. Default `44900`. The CLI validates the port and refuses to start if it is already in use.
- `--skip-update`: skip qgrid CLI self-update check.

When npm reports a newer `@cartanova/qgrid-cli`, including patch releases, the CLI installs that exact resolved version and restarts from the updated binary. Do not use a moving `@latest` install target for this path; exact versions avoid stale pnpm global project ranges. The npm lookup and global install are best-effort: a registry/package-manager outage is logged prominently and boot continues on the current qgrid version. A successful install is still verified against the exact resolved version before restart.

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
| `QGRID_OPENAI_TRANSPORT` | `websocket` | OpenAI transport selector (`https` or `websocket`). Invalid values fail at dispatcher configuration time. This is the only OpenAI runtime knob; there is no concurrency cap. |
| `QGRID_OPENAI_AUTOSCALE` / `QGRID_OPENAI_MIN_WORKERS_PER_TOKEN` / `QGRID_OPENAI_MAX_WORKERS_PER_TOKEN` / `QGRID_OPENAI_PERMITS_PER_TOKEN` | ignored | Removed. OpenAI requests run uncapped like Anthropic (stateless per-request execution); setting these has no effect. |
| `QGRID_TOKEN_WINDOW_KEEPALIVE_ENABLED` | off | Marks this instance as the Anthropic 5-hour window keepalive runner (2.8.0, `ea7feb3`). Only the literal `true` enables it; set it on exactly one instance per shared DB so developer instances do not fire duplicates. Two more gates apply: the global setting `qgrid.tokenWindowKeepaliveEnabled` (`false` turns everything off; changing it reschedules immediately) and the per-token `tokens.keepalive_enabled` flag (default `false`, dashboard settings-panel toggle). In 2.7.6 this env was a default-on global switch with no per-token opt-in. |
| `MAX_STRUCTURED_OUTPUT_RETRIES` | `1` for structured Anthropic streaming calls | Claude Code structured-output retry count for streaming only, clamped to at least 1 by qgrid. Non-streaming `generate` leaves the variable unset and uses Claude Code's default retry budget. |

## Server boot lifecycle

`packages/api/src/index.ts` runs `bootstrapServer` (`server-bootstrap.ts`) with a strict init → migrate → listen order:

1. The packaged CLI maps public `QGRID_DB_*` inputs to internal `SONAMU_DB_*`, then `Sonamu.init()` loads Sonamu's native dotenv snapshot for the active `NODE_ENV` and reads that internal database connection. Direct source API deployments set `SONAMU_DB_*` themselves. Selecting `staging` alone does not create a staging DB; the explicit database name remains authoritative.
2. `runRequiredMigrations` (`startup-migrations.ts`) applies pending migrations before the server listens. Migration failure exits the process — qgrid must not boot against a schema missing required columns such as `tokens.weight`. This is a hard-fail; it used to be a soft-fail warn inside `onStart`.
   - It uses a custom knex `migrationSource`, not the default directory loader. Migration **names** come from `../src/migrations/*.ts` relative to the running module (so they match the `.ts` names Sonamu records in `knex_migrations`), while the **module** is loaded from `./migrations/<same name>.js` when that compiled file exists (packaged CLI runs from `bundle/dist`), falling back to the `.ts` source under the ts loader in source runs.
   - Why (2.9.1): 2.9.0 pointed knex at `bundle/src/migrations`, so the first packaged release that shipped a pending migration (`20260901163614_alter_tokens_add1_alter1.ts`, `tokens.reauth_required`) crashed on boot with "Unknown file extension .ts" and pm2 restart-looped dev0. Pointing knex at `dist/migrations` instead would have made every historical `.ts`-named migration look pending. The publish workflow now boots the packed CLI against an empty Postgres and asserts every migration applied, because an import-only smoke test cannot catch this class of failure.
3. `Sonamu.createServer()` starts the server. Its `onStart` in `packages/api/src/sonamu.config.ts`:
   1. Ensures PostgreSQL `tokens_changed` triggers.
   2. Starts `TokenSubscriber` for LISTEN/NOTIFY plus periodic reconcile.
   3. Starts `OpenAIDispatcher` and `AnthropicDispatcher`.
   4. Logs server URL and provider readiness counts.

On shutdown, it stops provider dispatchers and the token subscriber.

### Runtime settings

Some env values are editable at runtime through the dashboard's Settings page, backed by the `settings` table (key-value). Resolution order is DB → env → code default: env stays as a fallback so a deploy that has not written any setting yet keeps working exactly as before.

- Editable: Slack delivery control (master switch, reminder on/off, reminder interval, quiet-hours window, weekend behaviour), and the Slack channel/user-map/bot-token. `SETTING_DEFS` in `setting.constant.ts` is the single definition — key, env name, type, bounds, and whether the change applies immediately or needs a restart. The `settings` table itself (`setting.entity.json`) only stores `(key, value)` strings; everything the UI needs to render and validate a key lives in that constant, not in the schema.
- Not editable: anything needed before the server can read its own database (`QGRID_DB_*`, `HOST`, `PORT`, `NODE_ENV`). These are exposed read-only on the same page so an operator can confirm which environment they are looking at; the DB password is masked.

### Restart from the dashboard

The Settings page can restart the server. There is no `pm2 restart` call — the process exits and the supervisor respawns it, which is what "restart" means here.

- `detectSupervisor` (`utils/process-supervisor.ts`) accepts only `pm_id` (pm2). `INVOCATION_ID` proves systemd launched a process but does not prove the unit has a restart policy, so it is not sufficient. Without pm2, `restartServer` returns 400 and the button is disabled: exiting with nothing to relaunch the process is a shutdown, not a restart. Presence is the signal, not the value — pm2 sets `pm_id=0` for the first process.
- Browser requests must be same-host: when `Origin` is present and its host differs from `X-Forwarded-Host`/`Host`, `restartServer` returns 403. Origin-less operational clients such as `curl` remain supported. This is CSRF protection, not a substitute for authenticating the management API at Caddy.
- The first restart request latches `restartPending`, blocks new native query/stream dispatch with 503, and marks only process-local active native request-log IDs as `error: server restarted`. Tool-result-waiting runs and externally owned logger runs are untouched. This is state reconciliation, not request draining.
- Exit is process-wide and one-shot. It runs after the restart response emits `finish`; a response `close` or a five-second fallback covers disconnects. Concurrent restart calls do not schedule multiple exits.
- The supervisor relaunches from `ecosystem.config.cjs`, not from the dying process's argv. That file carries no `--skip-update`, so each restart also runs the CLI self-update — a restart is a deploy. The confirmation dialog says so; dropping the update means adding `--skip-update` there.
- The relaunch reuses the environment pm2 captured when the app was first started. Neither the dashboard restart nor `pm2 restart qgrid` re-reads `ecosystem.config.cjs`, so an env edit in that file (for example `QGRID_TOKEN_WINDOW_KEEPALIVE_ENABLED`) stays invisible until `pm2 restart ecosystem.config.cjs --update-env` (or `pm2 delete` + `pm2 start`) followed by `pm2 save`. Verify with `GET /api/setting/listSettings`, which reports the env the process actually sees. dev0 ran for a week with the keepalive env in the file but not in the process because of this (2026-09-02).
- In-flight provider responses are not drained. There is no SIGTERM handler, so a restart during traffic cuts active responses, and the OpenAI pool needs 1–2 minutes before requests succeed again (`QgridDispatcher.startupState` answers 503 in that window). The dashboard stays locked after confirmation, observes an unavailable/not-ready health state, then waits for a later `ready: true` before refreshing settings.
- Slack channel, bot-token, and user-map changes are read on the next notification. Changing the expiry-reminder interval or toggling the reminder replaces the current timer immediately without sending a notification merely because the setting changed; process boot still performs the intended immediate reminder run.
- `slack.enabled` is the holiday switch: an operator turns it off for periods no rule can express. It suppresses ordinary notifications but not `urgent` ones, so a provider losing its last token still reports during a long break. `slack.remindersEnabled` is narrower — it stops only the repeat timer and preserves the chosen interval so re-enabling restores it.
- Quiet hours are `slack.quietFromHour`/`slack.quietUntilHour` (0–23, Asia/Seoul) plus `slack.notifyOnWeekends`. From > until reads as an overnight window (20→8); from < until reads as a same-day window, which night-shift teams may want. Equal values mean no quiet window at all. Out-of-range values fall back to 20/8 at runtime, since env can bypass the stored-value validation.
- `POST /api/setting/triggerExpiryReminder` sends the reminder once on demand and returns `{ sent }` so the caller can distinguish "nothing to remind about" from a delivery. It is sent as `urgent`, bypassing quiet hours and the master switch, because a human pressed the button.
- `immediate` means the API process that handled the update. The in-memory settings cache is not propagated to sibling processes; multi-instance deployments need a separate settings-change transport before treating the label as cluster-wide.
- The public settings API exposes the curated list/set/reset methods only. Keep generic Sonamu `save`/`del` methods internal so callers cannot bypass key validation, cache updates, or runtime change hooks.
- The settings response returns the Slack bot token in full so the authenticated dashboard can support its reveal toggle. Treat that endpoint as an operator-only surface at the deployment boundary. The database password remains masked and is never returned in full.

### Management API release gate

The historical dev0 Caddy configuration excluded all `/api/*` paths from Basic Auth. That makes a release containing `listSettings` expose the Slack bot token and restart endpoint anonymously even though the dashboard HTML is gated. npm `2.6.10` is already published, so a pm2 crash/respawn can trigger the CLI updater and activate that exposure without a manual restart. Do not treat "nobody will restart it" as a mitigation.

Before publishing any release that contains the settings/restart API, use this order:

1. Commit the code without changing package versions or publishing.
2. Have the user review the code and deployment draft.
3. Apply the exact-method/exact-path Caddy allowlist, validate the Caddyfile, and reload Caddy.
4. Verify unauthenticated settings/restart calls are blocked while every public SDK path still works.
5. Rotate the Slack bot token.
6. Align the `2.6.11` package version, bundled qgrid skills, and Notion release documentation.
7. Publish npm packages.
8. Restart qgrid.
9. Verify readiness and confirm old worker/process PIDs are gone.

Caddy must be fixed before npm publish, because publish—not the later manual restart—is the point where pm2 autorestart can pick up the vulnerable build. The public exception list is method plus exact path: POST `/api/qgrid/query`, `/api/qgrid/prepareStream`, `/api/qgrid/createRun`, `/api/qgrid/appendStep`, `/api/qgrid/finishRun`; GET `/api/qgrid/queryStream`, `/api/qgrid/health`, `/api/healthcheck`; and `/callback`. Recheck this list against `packages/ai-sdk/src/index.ts` and `packages/ai-sdk/src/utils.ts` whenever the SDK contract changes.

This allowlist preserves anonymous inference and logger database writes for SDK compatibility. It protects management data but is not a complete API security boundary; adding an SDK/API key is a separate follow-up. A browser already authenticated to the dashboard's Basic Auth protection sends the same credentials on same-origin settings requests, so protecting `/api/setting/*` does not break the settings page or secret reveal control.

### Readiness during startup

HTTP listening opens before the dispatchers finish starting, so requests can arrive while a provider is still unavailable. OpenAI startup loads token metadata and creates no Codex child processes.

- `QgridDispatcher.startupState` tracks each provider as `starting` → `ready` or `failed`. A request for an unready provider throws `ServiceUnavailableException` (503, with a `Retry-After` header) while starting, and `InternalServerErrorException` (500) once initialization has failed — retrying helps in the first case and never in the second. Both used to be `QuotaError`, which told callers their tokens were exhausted and gave them nothing to act on.
- `GET /api/qgrid/health` reports `ready` plus per-provider state. A 200 alone does not mean requests will succeed; read `providers` for that.
- `handleServerError` trusts `statusCode` only on `instanceof SoException`. Sonamu's own `isSoException` is a `statusCode !== undefined` duck-type check, which would pass upstream fetch errors straight through and echo an upstream 401 as if the caller were unauthorized.

## OAuth callbacks

- Anthropic OAuth: loopback dashboards use `/callback` on the qgrid server (base derived per request from `Origin`, falling back to `X-Forwarded-Host`/`Host`). Remote dashboards cannot use a public callback (client redirect-URI allowlist), so `oauthStart` returns `mode: "code"` with the console callback and the user pastes the shown `code#state` into the dashboard (`oauthComplete`). No env configuration either way; direct non-HTTP calls fall back to localhost and `PORT`.
- OpenAI OAuth uses direct PKCE and the Codex CLI's registered loopback callback. Local dashboards complete through a temporary 1455/1457 relay; remote dashboards return `mode: "code"` and ask the user to paste the full callback URL so qgrid can exchange it directly.
