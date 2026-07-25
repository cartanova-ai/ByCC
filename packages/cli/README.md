# @cartanova/qgrid-cli

**English** · [한국어](./README.ko.md)

Run the Qgrid server in one line. An LLM proxy that exposes OpenAI/Anthropic subscription credits as an HTTP API + dashboard.

## Install

```bash
npm i -g @cartanova/qgrid-cli
```

Installing also syncs the qgrid skills automatically:

- global install: `~/.codex/skills/qgrid`, `~/.claude/skills/qgrid`
- project install: `.agents/skills/qgrid`, `.claude/skills/qgrid`

Project installs create symlinks, falling back to copies when symlinking fails.

## Preparing PostgreSQL

Qgrid needs PostgreSQL to store OAuth tokens and request logs.
If you already have a reachable PostgreSQL, connect with `--db` or the `SONAMU_DB_*` environment variables.
If you don't have one locally, you can spin one up with Docker:

```bash
docker run --name qgrid-postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=qgrid \
  -p 5432:5432 \
  -d postgres:18
```

## Usage

```bash
# Run with a DB URL
qgrid --db postgres://user:password@host:port/dbname

# Specify a port
qgrid --db postgres://... -p 3000

# Configure the DB with environment variables (flags can be omitted)
export QGRID_DB_HOST=dev.example.com
export QGRID_DB_PORT=5432
export QGRID_DB_USER=postgres
export QGRID_DB_PASSWORD=postgres
export QGRID_DB_NAME=qgrid
qgrid
```

The CLI translates the public `QGRID_DB_*` settings into Sonamu's internal
`SONAMU_DB_*` variables. The packaged CLI defaults to `NODE_ENV=production`;
set `NODE_ENV=staging` only when intentionally running it as a remote
non-production service. This profile selection never creates or renames the
database selected by `QGRID_DB_NAME`. The packaged CLI rejects `development`
and `test`, which require the source development layout.

Once the server is up, open the dashboard at `http://localhost:44900` → register tokens through OAuth login.
With `-p, --port` set, connect on that port instead.

The server port is determined only by the default `44900` or `--port`. The `PORT` environment variable is not read as CLI server port input.
If the selected port is already in use, the CLI exits with an error instead of killing the existing process or falling back to another port.

Stop with Ctrl+C.

## Options

```
qgrid [options]

  --db <url>         PostgreSQL connection URL
  -p, --port <port>  Server port (default: 44900)
  --skip-update      Skip the automatic update check
  -V, --version      Print version
  -h, --help         Help
```

On startup the CLI checks the latest version on npm and self-updates whenever the installed version differs, including patch releases.
The updater installs the exact published version it just resolved and restarts from the updated binary.

## Environment variables

Without the `--db` flag, DB connection info is read from:

| Variable | Default |
|------|--------|
| `QGRID_DB_HOST` | `localhost` |
| `QGRID_DB_PORT` | `5432` |
| `QGRID_DB_USER` | `postgres` |
| `QGRID_DB_PASSWORD` | `postgres` |
| `QGRID_DB_NAME` | `qgrid` |

Server behavior variables:

| Variable | Description | Default |
|------|------|--------|
| `NODE_ENV` | Sonamu runtime profile. Set `staging` for a remote non-production deployment | `production` |
| `QGRID_WORKERS_PER_TOKEN` | codex workers per OpenAI token | `3` (max 5) |
| `QGRID_PUBLIC_BASE_URL` | Public base URL for the Anthropic OAuth callback. Set it when the server is accessed remotely | `http://localhost:<port>/callback` when unset |
| `QGRID_OPENAI_THREAD_REUSE` | Set to `false` to disable OpenAI thread reuse (prompt caching) | enabled |

## Prerequisites

- Node.js >= 20
- PostgreSQL
- Docker (if running PostgreSQL locally as a container)
- [Codex CLI](https://github.com/openai/codex) (for OpenAI models)
- [Claude Code](https://www.anthropic.com/claude-code) (for Anthropic models)

## How it works

The CLI ships the Sonamu-based server as a built-in bundle. On launch:

1. Verify the DB connection
2. Start the server (API + dashboard web UI)
3. Load registered tokens from the DB. Later token additions/changes propagate to the running server in real time via PostgreSQL LISTEN/NOTIFY
4. **OpenAI tokens**: spawn N persistent codex app-server processes per token (default 3, max 5), communicating over JSON-RPC. Requests are routed round-robin across idle workers; when all are busy they queue (up to 60 seconds). Multi-turn requests carrying a `sessionKey` are routed back to the same thread for prompt-cache hits
5. **Anthropic tokens**: spawn a fresh, isolated claude process per request (`stream-json` in/out). Tokens are selected least-used-first. OAuth tokens are refreshed automatically
6. Tokens over their quota threshold (default 80%) are excluded from routing (usage-lookup failures fail open)

The Qgrid app itself does not depend on Docker, but PostgreSQL is required. If you don't run PostgreSQL locally, running it in Docker is the simplest setup.

## SDK integration

Once the server is running, call it with [`@cartanova/qgrid-ai-sdk`](../ai-sdk/README.md):

```typescript
import { generateText } from "ai";
import { qgrid } from "@cartanova/qgrid-ai-sdk";

const { text } = await generateText({
  model: qgrid("openai/gpt-5.4-mini"),
  prompt: "What's the weather in Seoul?",
});
```

See the [`@cartanova/qgrid-ai-sdk` README](../ai-sdk/README.md) for details.
