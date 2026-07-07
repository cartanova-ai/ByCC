# Qgrid

**English** · [한국어](./README.ko.md)

**Use your LLM subscription tokens like an API.** Qgrid is an LLM proxy server that exposes OpenAI/Anthropic subscription credits as an HTTP API.

Call GPT-5.5, Claude Opus, and more on a **flat-rate subscription** instead of pay-as-you-go API keys. Pool the quotas of N accounts and distribute requests in parallel.

---

## How it differs from other subscription proxies

Existing subscription-token proxies (claude-proxy and the like) are **single-turn text proxies** — they invoke a CLI once and return text. Subscription tokens aren't usable through an official API, only through the CLI/app, and a bare CLI invocation doesn't support API features like tool calls, structured output, or multi-turn agent loops.

Qgrid solves this by implementing an AI SDK `LanguageModelV3` custom provider on top of two CLI runtimes:

- **OpenAI** — [codex app-server](https://github.com/openai/codex), a JSON-RPC server that exposes the Responses API on a subscription token. Qgrid keeps persistent worker processes per token and reuses conversation threads for prompt caching.
- **Anthropic** — Claude Code in `stream-json` mode. Qgrid spawns a fresh, isolated process per request and replays the full conversation history, so multi-turn works without persistent sessions.

As a result:

- **Tool Calling** — The AI SDK's `tools` option works as-is on both providers. The server produces tool-call shapes through structured output emulation, and the AI SDK manages tool execution.
- **Multi-step Agent Loop** — `stopWhen` and `maxSteps` automatically repeat tool-call → tool execution → next turn. You can build agents on a subscription token.
- **Structured Output** — Enforce a JSON schema with `Output.object({ schema })`. OpenAI enforces it through codex structured output; Anthropic goes through Claude Code `--json-schema` with post-validation that fails honestly instead of returning broken JSON.
- **Prompt Caching** — Pass a `sessionKey` and multi-turn conversations are routed back to the same codex thread, hitting the provider prompt cache (OpenAI).
- **Streaming** — Real-time text streaming over SSE via the [Sonamu Framework](https://github.com/cartanova-ai/sonamu).

---

## Why Qgrid?

- **Zero API key cost** — Reuse the OpenAI/Anthropic subscription tokens you already pay for. No separate pay-as-you-go API key required.
- **Tool Calling + Agent Loop** — Run tool calls and multi-step agent loops on a subscription token. Not just a plain text proxy.
- **AI SDK compatible** — Swap a single `model` line in your existing code. `generateText`, `streamText`, structured output, and tool calls all work.
  ```ts
  model: qgrid("openai/gpt-5.4-mini")  // just change this
  ```
- **Pool N subscriptions** — Combine teammates' subscription accounts for parallel processing. Distribute concurrent requests across N workers per token, with per-token quota thresholds that automatically exclude overloaded tokens from routing.
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
-  model: openai("gpt-5.4-mini"),
+  model: qgrid("openai/gpt-5.4-mini"),
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

- **OpenAI** — Spawns N persistent codex app-server processes per token. Communicates over JSON-RPC. Routes requests round-robin across idle workers and queues when all are busy (60s timeout). Multi-turn conversations with a `sessionKey` are routed back to the same thread for prompt-cache hits.
- **Anthropic** — Spawns a fresh, isolated Claude Code process per request (`stream-json` in/out) with per-token config isolation. Conversation history is replayed each turn; OAuth tokens are refreshed automatically.
- **Quota threshold** — Each token has a utilization threshold (default 80%). Tokens over the threshold are excluded from routing until their rolling window recovers.
- **Request Log** — Records each request's generate steps, tool-call steps, reasoning, token usage, cache metrics, TTFT, and cost in the DB. View them in the dashboard.

> **Stripping the Codex built-in harness:** codex app-server auto-injects built-in tools (shell, web_search, apply_patch, and 14 others) and instruction blocks (permissions, environment_context, skills, ~10KB) on every request. Qgrid disables all of these via the worker's `config.toml` and runs with a minimal system prompt and no environment. As a result, codex behaves like a **plain text-generation endpoint rather than a coding agent**, with no unnecessary input-token overhead and no stray built-in tool calls. The only tools the model sees are the ones you pass through the AI SDK.

---

## SDK Usage

For detailed usage, see the [`@cartanova/qgrid-ai-sdk` README](./packages/ai-sdk/README.md).

### Text generation

```typescript
const { text } = await generateText({
  model: qgrid("openai/gpt-5.4-mini"),
  system: "You are an academic paper summarizer.",
  prompt: paperText,
});
```

### Structured Output

```typescript
const { output } = await generateText({
  model: qgrid("openai/gpt-5.4"),
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
  model: qgrid("openai/gpt-5.4-mini"),
  prompt: "Explain the benefits of TypeScript",
});

for await (const chunk of textStream) {
  process.stdout.write(chunk);
}
```

### Tool Calling

```typescript
const { text } = await generateText({
  model: qgrid("openai/gpt-5.4-mini"),
  prompt: "What's the weather in Seoul?",
  tools: {
    getWeather: tool({
      description: "Get the current weather for a city",
      parameters: z.object({ city: z.string() }),
      execute: async ({ city }) => ({ temperature: 22, condition: "sunny" }),
    }),
  },
});
```

### Prompt caching (sessionKey)

```typescript
// Route multi-turn conversations to the same codex thread → prompt cache hits (OpenAI)
const { text } = await generateText({
  model: qgrid("openai/gpt-5.4-mini"),
  prompt: nextTurn,
  providerOptions: { qgrid: { sessionKey: "chat-room-42" } },
});
```

### Image generation

```typescript
// OpenAI route, generateText only — enables Codex's image_generation tool for this request
const result = await generateText({
  model: qgrid("openai/gpt-5.4"),
  prompt: "An illustration of a whale flying through space",
  providerOptions: { qgrid: { imageGeneration: true } },
});

const image = result.files[0]; // mediaType: "image/png", base64
```

Reference images are supported through AI SDK multimodal message parts:

```typescript
const result = await generateText({
  model: qgrid("openai/gpt-5.4"),
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
| OpenAI | `openai/gpt-5.5`, `openai/gpt-5.4`, `openai/gpt-5.4-mini`, `openai/gpt-5.3-codex`, `openai/gpt-5.3-codex-spark`, `openai/gpt-5.2` |
| Anthropic | `anthropic/claude-sonnet-5`, `anthropic/claude-opus-4-8`, `anthropic/claude-opus-4-7`, `anthropic/claude-opus-4-6`, `anthropic/claude-opus-4-5`, `anthropic/claude-opus-4-1`, `anthropic/claude-opus-4`, `anthropic/claude-sonnet-4-7`, `anthropic/claude-sonnet-4-6`, `anthropic/claude-sonnet-4-5`, `anthropic/claude-sonnet-4`, `anthropic/claude-haiku-4-5` |

> `claude-sonnet-4-6`, `claude-opus-4-6`, and `claude-opus-4-8` automatically run with a 1M-token context window.

---

## Environment variables

| Variable | Description | Default |
|---|---|---|
| `QGRID_URL` | Qgrid server address (SDK) | `http://localhost:44900` |
| `QGRID_PROJECT_NAME` | Request log project name (SDK/logger). Enables per-project filtering in the dashboard | (empty) |
| `QGRID_DB_HOST` | PostgreSQL host | `localhost` |
| `QGRID_DB_PORT` | PostgreSQL port | `5432` |
| `QGRID_DB_USER` | PostgreSQL user | `postgres` |
| `QGRID_DB_PASSWORD` | PostgreSQL password | `postgres` |
| `QGRID_DB_NAME` | Database name | `qgrid` |
| `QGRID_WORKERS_PER_TOKEN` | Workers per OpenAI token | `3` (max 5) |
| `QGRID_PUBLIC_BASE_URL` | Public base URL for the Anthropic OAuth callback | `http://localhost:<port>` |
| `QGRID_OPENAI_THREAD_REUSE` | Set to `false` to disable OpenAI thread reuse (prompt caching) | enabled |

---

## Package structure

```
packages/
├── ai-sdk/  ← @cartanova/qgrid-ai-sdk (AI SDK v6 provider + logger)
├── api/     ← Sonamu server (QgridDispatcher, Request Log, OAuth)
├── web/     ← Dashboard React app (TanStack Router + Query)
├── sdk/     ← @cartanova/qgrid-sdk (v1, deprecated)
└── cli/     ← @cartanova/qgrid-cli (bundles the server)
```

---

## Prerequisites

- Node.js >= 20
- PostgreSQL
- Docker (if running PostgreSQL locally as a container)
- [Codex CLI](https://github.com/openai/codex) (for OpenAI models)
- [Claude Code](https://www.anthropic.com/claude-code) (for Anthropic models)

---

## Notes

- **OpenAI models**: codex app-server based. Sampling parameters like `temperature` and `maxOutputTokens` are not supported.
- **Anthropic models**: Claude Code based. Requires OAuth login. Tool calling and structured output work the same as OpenAI; `sessionKey` thread reuse does not apply because every request runs in a fresh process.
- **Structured output on Anthropic**: unlike codex (constrained decoding), Claude Code's `--json-schema` guides rather than constrains generation, so complex schemas can occasionally fail validation. Qgrid runs a single attempt (internal retries disabled by default) and surfaces an explicit error instead of returning broken JSON.
- **Quota management**: Subscription rate limits apply (5-hour / 7-day rolling window). Each token has a quota threshold (default 80%) that excludes it from routing when exceeded; tokens can also be disabled manually in the dashboard.
