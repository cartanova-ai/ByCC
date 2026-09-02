# Qgrid

**English** · [한국어](./README.ko.md)

**Use your LLM subscription tokens like an API.** Qgrid is an LLM proxy server that exposes OpenAI/Anthropic subscription credits as an HTTP API.

Call GPT-5.5, Claude Opus, and more on a **flat-rate subscription** instead of pay-as-you-go API keys. Pool the quotas of N accounts and distribute requests in parallel.

---

## How it differs from other subscription proxies

Existing subscription-token proxies (claude-proxy and the like) are **single-turn text proxies** — they invoke a CLI once and return text. Subscription tokens aren't usable through an official API, only through the CLI/app, and a bare CLI invocation doesn't support API features like tool calls, structured output, or multi-turn agent loops.

Qgrid solves this with an AI SDK `LanguageModelV3` custom provider over two subscription-backed runtimes:

- **OpenAI** — Direct HTTPS requests to `https://chatgpt.com/backend-api/codex/responses`, with streaming responses decoded from SSE. Qgrid sends Codex CLI identity headers and replays the full conversation history on every turn. An opaque key derived from `sessionKey` supplies prompt-cache affinity without retaining provider threads.
- **Anthropic** — Claude Code in `stream-json` mode. Qgrid spawns a fresh, isolated process per request and replays the full conversation history, so multi-turn works without persistent sessions.

As a result:

- **Tool Calling** — The AI SDK's `tools` option works as-is on both providers. The server produces tool-call shapes through structured output emulation, and the AI SDK manages tool execution.
- **Multi-step Agent Loop** — `stopWhen` and `maxSteps` automatically repeat tool-call → tool execution → next turn. You can build agents on a subscription token.
- **Structured Output** — Request a JSON schema with `Output.object({ schema })`. OpenAI enforces it through codex constrained decoding; Anthropic delivers the schema as prompt guidance (Claude Code runs in plain text mode — no `--json-schema` scoring or hidden retries), and validation happens in the consumer's zod. Non-conforming Anthropic output fails honestly instead of returning broken JSON.
- **Prompt Caching** — Pass a `sessionKey` to derive stable, opaque OpenAI prompt-cache affinity while Qgrid replays the full history on every request.
- **Streaming** — Real-time text streaming over SSE via the [Sonamu Framework](https://github.com/cartanova-ai/sonamu).

---

## Why Qgrid?

- **Zero API key cost** — Reuse the OpenAI/Anthropic subscription tokens you already pay for. No separate pay-as-you-go API key required.
- **Tool Calling + Agent Loop** — Run tool calls and multi-step agent loops on a subscription token. Not just a plain text proxy.
- **AI SDK compatible** — Swap a single `model` line in your existing code. `generateText`, `streamText`, structured output, and tool calls all work.
  ```ts
  model: qgrid("openai/gpt-5.6-luna")  // just change this
  ```
- **Pool N subscriptions** — Combine teammates' subscription accounts for parallel processing. Smooth weighted routing distributes requests across tokens, while per-token quota thresholds exclude overloaded tokens.
- **Request Log dashboard** — Inspect token usage, cost, cache hits, TTFT, tool-call traces, and reasoning for every request in real time through a web UI.
- **Image generation** — Opt into Codex's `image_generation` tool per request and receive PNG files through the standard AI SDK response.
- **OpenAI + Anthropic** — Register subscription tokens for both. One-click OAuth login.

---

## Quick Start

### 1. Run the server

```bash
npm i -g @cartanova/qgrid-cli
```

Qgrid requires PostgreSQL to store OAuth tokens and request logs. If you already have a reachable PostgreSQL, connect to it directly; otherwise you can spin one up with Docker:

```bash
docker run --name qgrid-postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=qgrid \
  -p 5432:5432 \
  -d postgres:18

qgrid --db postgres://postgres:postgres@localhost:5432/qgrid
```

Open the dashboard at `http://localhost:44900` → register tokens (OAuth login).

> All authentication follows each provider's OAuth flow.
> PostgreSQL is required to persist the token received on successful login (**postgres:18**).

### 2. Install the SDK

```bash
pnpm add @cartanova/qgrid-ai-sdk
```

### 3. Change a single line of code

```diff
 import { generateText } from "ai";
-import { openai } from "@ai-sdk/openai";
+import { qgrid } from "@cartanova/qgrid-ai-sdk";

 const { text } = await generateText({
-  model: openai("gpt-5.6-luna"),
+  model: qgrid("openai/gpt-5.6-luna"),
   prompt: "What's the weather in Seoul?",
 });
```

Your existing AI SDK code stays the same. Change only `model` and requests go through the Qgrid server using your subscription token.

### 4. (Optional) Add the logger to another provider

If you're already using the google/openai provider directly, **add one line** to see logs in the dashboard:

```diff
+import { createQgridLogger } from "@cartanova/qgrid-ai-sdk";

 const { text } = await generateText({
   model: google("gemini-3-flash"),
   prompt: "A complex question",
+  experimental_telemetry: createQgridLogger({ serverUrl: "http://localhost:44900" }),
 });
```

---

## Architecture

![Qgrid architecture](./assets/qgrid-architecture.en.svg)

- **OpenAI** — Calls `https://chatgpt.com/backend-api/codex/responses` directly. The default `QGRID_OPENAI_TRANSPORT=websocket` mode scheme-swaps that URL to `wss` and reuses a connection for sequential requests with the same prompt-cache affinity. Requests without cache affinity use one connection each. `QGRID_OPENAI_TRANSPORT=https` remains available but does not preserve prompt-cache connection affinity. Qgrid does not replay ambiguous requests. Only a definitively rejected 401 handshake may refresh credentials and reconnect once. Requests run uncapped; new work uses smooth weighted routing across eligible tokens. Invalid selector values fail during dispatcher configuration.
- **Anthropic** — Spawns a fresh, isolated Claude Code process per request (`stream-json` in/out) with per-token config isolation. Conversation history is replayed each turn; OAuth tokens are refreshed automatically.
- **Quota threshold** — Each token has a utilization threshold (default 80%). Tokens over the threshold are excluded from routing until their rolling window recovers.
- **Request Log** — Records each request's generate steps, tool-call steps, reasoning, token usage, cache metrics, TTFT, and cost in the DB. View them in the dashboard.

> **Private backend notice:** The OpenAI route uses ChatGPT's private Codex backend rather than a documented public API. Its URL, request fields, identity-header requirements, SSE events, quota response, and availability may change without notice. This migration is covered by mocked protocol and transport tests; it is not a claim of verification against a live provider account.

---

## SDK Usage

For detailed usage, see the [`@cartanova/qgrid-ai-sdk` README](./packages/ai-sdk/README.md).

### Text generation

```typescript
const { text } = await generateText({
  model: qgrid("openai/gpt-5.6-luna"),
  system: "You are an academic paper summarizer.",
  prompt: paperText,
});
```

### Structured Output

```typescript
const { output } = await generateText({
  model: qgrid("openai/gpt-5.6-terra"),
  prompt: paperText,
  output: Output.object({
    schema: z.object({
      title: z.string(),
      authors: z.array(z.string()),
      keyFindings: z.array(z.string()),
    }),
  }),
});
```

### Streaming

```typescript
const { textStream } = streamText({
  model: qgrid("openai/gpt-5.6-luna"),
  prompt: "Explain the benefits of TypeScript",
});

for await (const chunk of textStream) {
  process.stdout.write(chunk);
}
```

### Tool Calling

```typescript
const { text } = await generateText({
  model: qgrid("openai/gpt-5.6-luna"),
  prompt: "What's the weather in Seoul?",
  tools: {
    getWeather: tool({
      description: "Get the current weather for a city",
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => ({ temperature: 22, condition: "sunny" }),
    }),
  },
  stopWhen: stepCountIs(3),
});
```

### Prompt caching (sessionKey)

```typescript
// Replay full history with stable opaque prompt-cache affinity (OpenAI)
const { text } = await generateText({
  model: qgrid("openai/gpt-5.6-luna"),
  prompt: nextTurn,
  providerOptions: { qgrid: { sessionKey: "chat-room-42" } },
});
```

### Image generation

```typescript
// OpenAI route, generateText only — enables Codex's image_generation tool for this request
const result = await generateText({
  model: qgrid("openai/gpt-5.6-terra"),
  prompt: "An illustration of a whale flying through space",
  providerOptions: { qgrid: { imageGeneration: true } },
});

const image = result.files[0]; // mediaType: "image/png", base64
```

Reference images are supported through AI SDK multimodal message parts:

```typescript
const result = await generateText({
  model: qgrid("openai/gpt-5.6-terra"),
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "Use this image as a style reference and create a poster" },
        { type: "file", mediaType: "image/png", data: referenceImageBase64 },
      ],
    },
  ],
  providerOptions: { qgrid: { imageGeneration: true } },
});
```

Reference images are sent as JSON data URLs, so compress or resize large photos before passing them in. The SDK rejects oversized base64 inputs with a clear error; WebP/JPEG is recommended for photos.

---

## CLI

```bash
npm i -g @cartanova/qgrid-cli

qgrid --db postgres://user:password@host:port/dbname
qgrid --db postgres://... -p 3000  # specify port
```

Installing the CLI also syncs the qgrid agent skill for coding agents — into `~/.codex/skills/qgrid` and `~/.claude/skills/qgrid` on a global install, or into the project's `.agents/skills` and `.claude/skills` on a project install. See the [`@cartanova/qgrid-cli` README](./packages/cli/README.md) for details.

You can configure the DB with environment variables:

```bash
export QGRID_DB_HOST=dev.example.com
export QGRID_DB_PORT=5432
export QGRID_DB_USER=postgres
export QGRID_DB_PASSWORD=postgres
export QGRID_DB_NAME=qgrid
qgrid
```

The CLI translates the public `QGRID_DB_*` settings into Sonamu's internal
`SONAMU_DB_*` variables. Only source deployments that run `packages/api`
without the CLI use `SONAMU_DB_*` directly. Use `NODE_ENV=staging` for a remote
non-production environment such as dev0 and `NODE_ENV=production` for
production. The profile does not create a database; `QGRID_DB_NAME` selects the
database explicitly.

---

## Team usage (shared DB)

When teammates point at the same PostgreSQL, they share the token pool:

```bash
# On each teammate's machine
qgrid --db postgres://user:pw@dev.example.com:5432/qgrid

# In each teammate's project
QGRID_URL=http://localhost:44900
QGRID_PROJECT_NAME=my-service   # labels request logs per project
```

In the dashboard you can filter the whole team's request logs by project — set `QGRID_PROJECT_NAME` in each project so workloads stay distinguishable as traffic grows.

---

## Supported models

| Provider | Models |
|---|---|
| OpenAI | `openai/gpt-5.6-sol`, `openai/gpt-5.6-terra`, `openai/gpt-5.6-luna`, `openai/gpt-5.5`, `openai/gpt-5.3-codex-spark` |
| Anthropic | `anthropic/claude-fable-5-1`, `anthropic/claude-fable-5`, `anthropic/claude-opus-5`, `anthropic/claude-sonnet-5`, `anthropic/claude-opus-4-8`, `anthropic/claude-opus-4-7`, `anthropic/claude-opus-4-6`, `anthropic/claude-opus-4-5`, `anthropic/claude-opus-4-1`, `anthropic/claude-opus-4`, `anthropic/claude-sonnet-4-7`, `anthropic/claude-sonnet-4-6`, `anthropic/claude-sonnet-4-5`, `anthropic/claude-sonnet-4`, `anthropic/claude-haiku-4-5` |

> `openai/gpt-5.4`, `openai/gpt-5.4-mini`, `openai/gpt-5.2`, and `openai/gpt-5.3-codex` are still accepted by the SDK type for backward compatibility, but the ChatGPT-subscription Codex route that qgrid uses no longer serves them. `gpt-5.4` and `gpt-5.4-mini` retired on 2026-08-31; use `openai/gpt-5.6-terra` and `openai/gpt-5.6-luna` instead.

> `claude-fable-5-1`, `claude-fable-5`, `claude-opus-5`, `claude-sonnet-5`, `claude-sonnet-4-6`, `claude-opus-4-6`, and `claude-opus-4-8` automatically run with a 1M-token context window. Fable 5.1/5 always run with adaptive thinking and Opus 5 keeps its default adaptive thinking behavior; qgrid's `effort` option controls reasoning depth. Fable 5.1 shares Fable 5's $10/$50 per-1M-token pricing but bills cache reads at $0.25 instead of $1.

### GPT-5.6 specifications

| Model | Context (qgrid OpenAI route) | Max output | Input / cached input / output per 1M tokens |
|---|---:|---:|---:|
| `openai/gpt-5.6-sol` | 372K | 128K | $5 / $0.50 / $30 |
| `openai/gpt-5.6-terra` | 372K | 128K | $2.50 / $0.25 / $15 |
| `openai/gpt-5.6-luna` | 372K | 128K | $1 / $0.10 / $6 |

All GPT-5.6 models support reasoning through `max`. Qgrid retains the observed subscription-route limits used by its model configuration: a 372K context window (95% effective — about 353K of usable input) and 128K maximum output. This is narrower than the 1.05M context listed for the public OpenAI API and is not attributed to a local runtime. Prompts over 272K input tokens apply a 2x input and 1.5x output surcharge to the full request; cache writes cost 1.25x the uncached input rate.

---

## Environment variables

| Variable | Description | Default |
|---|---|---|
| `QGRID_URL` | Qgrid server address (SDK) | `http://localhost:44900` |
| `QGRID_PROJECT_NAME` | Request log project name (SDK/logger). Enables per-project filtering in the dashboard | (empty) |
| `HOST` | Server listen host. A non-loopback value exposes the dashboard and admin APIs | `localhost` |
| `NODE_ENV` | Sonamu runtime profile: `development`, `test`, `staging`, or `production`. Use `staging` for remote non-production API deployments | `development` for direct API; `production` for CLI |
| `QGRID_DB_HOST` | PostgreSQL host (CLI) | `localhost` |
| `QGRID_DB_PORT` | PostgreSQL port (CLI) | `5432` |
| `QGRID_DB_USER` | PostgreSQL user (CLI) | `postgres` |
| `QGRID_DB_PASSWORD` | PostgreSQL password (CLI) | `postgres` |
| `QGRID_DB_NAME` | Database name (CLI) | `qgrid` |
| `SLACK_BOT_TOKEN` | Slack bot token for token-expiry notifications. Unset disables notifications | — |
| `SLACK_CHANNEL_ID` | Slack channel that receives those notifications | — |
| `SLACK_EXPIRY_REMINDER_INTERVAL_MINUTES` | Minutes between repeats of the session-expiry alert. Unset or 0 disables | — |
| `SLACK_USER_MAP` | `tokenName:SlackUserId` pairs; mapped tokens are mentioned by owner | — |

> Qgrid does not add a separate authentication guard to dashboard APIs. Keep `HOST` on loopback unless access is protected by a trusted network or reverse proxy. A public bind exposes every admin endpoint, including the Monit tab's server log feed.
>
> When running `packages/api` directly, set the same values with Sonamu's native `SONAMU_DB_*` variables.

---

## Package structure

```
packages/
├── ai-sdk/  ← @cartanova/qgrid-ai-sdk (AI SDK v6 provider + logger)
├── api/     ← Sonamu server (QgridDispatcher, Request Log, OAuth)
├── web/     ← Dashboard React app (TanStack Router + Query)
└── cli/     ← @cartanova/qgrid-cli (bundles the server)
```

---

## Prerequisites

- Node.js >= 20
- PostgreSQL
- Docker (if running PostgreSQL locally as a container)
- [Claude Code](https://www.anthropic.com/claude-code) (for Anthropic models)

---

## Notes

- **OpenAI models**: use the direct private Codex Responses backend. Sampling parameters like `temperature` and `maxOutputTokens` are not supported by this route.
- **Anthropic models**: Claude Code based. Requires OAuth login. Tool calling and object structured output are supported; OpenAI-style `sessionKey` cache affinity does not apply because every request runs in a fresh process.
- **Structured output on Anthropic**: unlike codex (constrained decoding), the Anthropic route has no enforcement mechanism. Qgrid renders the caller's original schema — and the tool envelope contract when tools are present — as text at the end of the system prompt, runs Claude Code in plain text mode, and strips code fences from the reply. The response is JSON text guided by the schema, not server-validated JSON: **validate it with your own schema (the AI SDK's `Output.object` zod does this automatically)**. Non-conforming output surfaces as an explicit validation failure on your side instead of hidden Claude Code retries.
- **Positional tuples (OpenAI)**: OpenAI normalizes and enforces positional tuple constraints in supported positive schema positions. Tuples in negative, conditional, or otherwise non-normalizable positions fail with HTTP 400 instead of being rewritten with changed semantics. References from those positions are rejected for the same reason; definitions are normalized globally. Tuple nodes must explicitly use `type: "array"`; nullable tuples use `anyOf`. The Anthropic route delivers the schema as prompt text without rewriting, so these restrictions do not apply there.
- **Schema references (OpenAI)**: structured schemas accept only local root-relative JSON Pointer `$ref` values targeting the document root or a chain of `$defs`/`definitions` entry roots. References into properties, tuple internals, conditionals, or literal values fail with HTTP 400 because normalization can move or rewrite those targets. Resource IDs, anchors, external refs, dynamic refs, and recursive refs are also rejected. The Anthropic route passes the schema through verbatim, so any `$ref` form the model can read is accepted.
- **Schema budget**: output/tool schema serialization, tool names, descriptions, JSON escaping, and composition framing share one aggregate 512 KiB UTF-8 budget.
- **Quota management**: Subscription rate limits apply (5-hour / 7-day rolling window). Each token has a quota threshold (default 80%) that excludes it from routing when exceeded; tokens can also be disabled manually in the dashboard.
