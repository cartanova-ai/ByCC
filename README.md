# Qgrid

**English** · [한국어](./README.ko.md)

**Use your LLM subscription tokens like an API.** Qgrid is an LLM proxy server that exposes OpenAI/Anthropic subscription credits as an HTTP API.

Call GPT-5.5, Claude Opus, and more on a **flat-rate subscription** instead of pay-as-you-go API keys. Pool the quotas of N accounts and distribute requests in parallel.

---

## How it differs from other subscription proxies

Existing subscription-token proxies (claude-proxy and the like) are **single-turn text proxies** — they invoke a CLI once and return text. Subscription tokens aren't usable through an official API, only through the CLI/app, and the CLI doesn't support API features like tool calls or structured output.

> **Note:** While `claude -p` can mimic tool-call shapes through structured output emulation, each `claude -p` call is an independent single-turn invocation, so it **does not support multi-turn.** The agent loop of tool-call → tool execution → feeding the result into the next turn is fundamentally impossible. Anthropic also plans to restrict third-party use of `claude -p` as of 2026-06-18.

Qgrid solves this by **using codex app-server as the backend.** codex app-server is a JSON-RPC server that lets you use OpenAI's Responses API with a subscription token, and Qgrid implements an AI SDK `LanguageModelV3` custom provider on top of it. As a result:

- **Tool Calling** — The AI SDK's `tools` option works as-is. The server produces tool-call shapes through structured output emulation, and the AI SDK manages tool execution.
- **Multi-step Agent Loop** — `stopWhen` and `maxSteps` automatically repeat tool-call → tool execution → next turn. You can build agents on a subscription token.
- **Structured Output** — Enforce a JSON schema with `Output.object({ schema })`. No parse failures.
- **Streaming** — Real-time text streaming over SSE via the [Sonamu Framework](https://github.com/cartanova-ai/sonamu).

---

## Why Qgrid?

- **Zero API key cost** — Reuse the OpenAI/Anthropic subscription tokens you already pay for. No separate pay-as-you-go API key required.
- **Tool Calling + Agent Loop** — Run tool calls and multi-step agent loops on a subscription token. Not just a plain text proxy.
- **AI SDK compatible** — Swap a single `model` line in your existing code. `generateText`, `streamText`, structured output, and tool calls all work.
  ```ts
  model: qgrid("openai/gpt-5.4-mini")  // just change this
  ```
- **Pool N subscriptions** — Combine teammates' subscription accounts for parallel processing. Distribute concurrent requests across N workers per token.
- **Request Log dashboard** — Inspect token usage, cost, tool-call traces, and reasoning for every request in real time through a web UI.
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

- **OpenAI** — Spawns N codex app-server processes per token. Communicates over JSON-RPC. Handles parallel requests with queuing.
- **Anthropic** — Calls through the claude CLI. OAuth tokens are refreshed automatically.
- **Request Log** — Records each request's generate steps, tool-call steps, reasoning, token usage, and cost in the DB. View them in the dashboard.

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

---

## CLI

```bash
npm i -g @cartanova/qgrid-cli

qgrid --db postgres://user:password@host:port/dbname
qgrid --db postgres://... -p 3000  # specify port
```

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
```

In the dashboard you can filter the whole team's request logs by project.

---

## Supported models

| Provider | Models |
|---|---|
| OpenAI | `openai/gpt-5.5`, `openai/gpt-5.4`, `openai/gpt-5.4-mini`, `openai/gpt-5.2`, `openai/gpt-5.3-codex` |
| Anthropic | `anthropic/claude-sonnet-4-7`, `anthropic/claude-opus-4-7`, `anthropic/claude-haiku-4-5`, and more |

---

## Environment variables

| Variable | Description | Default |
|---|---|---|
| `QGRID_URL` | Qgrid server address (SDK) | `http://localhost:44900` |
| `QGRID_DB_HOST` | PostgreSQL host | `localhost` |
| `QGRID_DB_PORT` | PostgreSQL port | `5432` |
| `QGRID_DB_NAME` | Database name | `qgrid` |
| `QGRID_WORKERS_PER_TOKEN` | Workers per OpenAI token | `3` (max 5) |

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
- **Anthropic models**: claude CLI based. Requires OAuth login.
- **Quota management**: Subscription rate limits apply (5-hour / 7-day rolling window). Exhausted tokens can be disabled in the dashboard.
