# @cartanova/qgrid-ai-sdk

**English** · [한국어](./README.ko.md)

AI SDK v6 custom `LanguageModelV3` provider for [qgrid](https://github.com/cartanova-ai/Qgrid).

**Without changing your existing AI SDK code, swap a single `model` line to get subscription-token pooling (N tokens × parallel workers) + the request log dashboard.**

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

If you already use another provider (google, openai, ...) directly, add **a single logger line** to see every agent step (generate, tool-call, reasoning) in the qgrid dashboard.

```diff
 const { text } = await generateText({
   model: google("gemini-3-flash"),
   prompt: "A complex question",
+  experimental_telemetry: createQgridLogger({ serverUrl: "http://localhost:44900" }),
 });
```

## Install

```bash
pnpm add @cartanova/qgrid-ai-sdk
```

Peer dependencies: `ai@^6.0.0`, `@ai-sdk/provider@^3.0.0`

## Quick start

```typescript
import { generateText } from "ai";
import { qgrid } from "@cartanova/qgrid-ai-sdk";

const { text } = await generateText({
  model: qgrid("openai/gpt-5.4-mini"),
  prompt: "What's the weather in Seoul?",
});
```

A qgrid server (`http://localhost:44900`) must be running.

## Usage
> Before you start: all client-side usage is identical to the [AI SDK](https://ai-sdk.dev/docs/ai-sdk-core).

### Text generation

```typescript
import { generateText } from "ai";
import { qgrid } from "@cartanova/qgrid-ai-sdk";

const { text } = await generateText({
  model: qgrid("openai/gpt-5.4-mini"),
  system: "You are an academic paper summarizer.",
  prompt: paperText,
});
```

### Structured Output
> See the [AI SDK structured output guide](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data)

```typescript
import { generateText, Output } from "ai";
import { qgrid } from "@cartanova/qgrid-ai-sdk";
import { z } from "zod";

const { output } = await generateText({
  model: qgrid("openai/gpt-5.4"),
  system: "Extract the paper metadata.",
  prompt: paperText,
  output: Output.object({
    schema: z.object({
      title: z.string(),
      authors: z.array(z.string()),
      keyFindings: z.array(z.string()),
    }),
  }),
});

console.log(output.title, output.authors);
```

Schemas with a top-level `object` are forwarded to server-side structured output and enforced.
If the top level is not an `object` (e.g. array), the AI SDK falls back to client-side parsing and a warning is logged.

> **Note for Anthropic models:** OpenAI/codex structured output constrains decoding to the schema, so this class of failure is rare there. Claude Code's `--json-schema`, however, works as a StructuredOutput tool + post-hoc validation, so the model may fail to honor a complex schema. qgrid disables Claude Code's internal retries by default (`MAX_STRUCTURED_OUTPUT_RETRIES=1` = one attempt; values below 1 are clamped to 1) and returns an explicit error on validation failure instead of broken JSON. You can raise the server env var to allow retries, but rejected attempts accumulating on the streaming path can break AI SDK parsing, so keeping the default is recommended.

### Streaming

```typescript
import { streamText } from "ai";
import { qgrid } from "@cartanova/qgrid-ai-sdk";

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
import { generateText, tool } from "ai";
import { qgrid } from "@cartanova/qgrid-ai-sdk";
import { z } from "zod";

const { text } = await generateText({
  model: qgrid("openai/gpt-5.4-mini"),
  prompt: "What's the weather in Seoul?",
  tools: {
    getWeather: tool({
      description: "Get the current weather for a city",
      parameters: z.object({ city: z.string() }),
      execute: async ({ city }) => {
        return { temperature: 22, condition: "sunny" };
      },
    }),
  },
});
```

Tool calls work through the qgrid server's structured output emulation.
The AI SDK manages tool execution; qgrid handles only each turn's LLM call.

### Provider Options

All qgrid-specific options go under the `providerOptions.qgrid` namespace. (Not `providerOptions.openai`.)
AI SDK types the outer `providerOptions` as a generic JSON record, so apply the exported
`QgridProviderOptions` type to the nested `qgrid` value with `satisfies`. This preserves
literal inference and catches misspelled or invalid qgrid options at compile time.

```typescript
import { generateText } from "ai";
import { qgrid, type QgridProviderOptions } from "@cartanova/qgrid-ai-sdk";

const { text } = await generateText({
  model: qgrid("openai/gpt-5.4"),
  prompt: "Analyze this complex problem",
  providerOptions: {
    qgrid: {
      effort: "high",
      reasoningSummary: "concise",
      verbosity: "medium",
    } satisfies QgridProviderOptions,
  },
});
```

| Option | Values | Applies to | Description |
|---|---|---|---|
| `logger` | `boolean` | both providers | qgrid request logging. Defaults to `true`; `false` disables request-log persistence for this generation without disabling client tools or multi-step continuation |
| `sessionKey` | `string` | OpenAI only | Multi-turn conversation identifier. The same key routes to the same codex thread for prompt-cache hits (see [below](#multi-turn-prompt-cache-sessionkey)) |
| `effort` | `"none"` \| `"minimal"` \| `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` \| `"max"` | both providers (supported values are model-dependent, e.g. `"max"` is GPT-5.6+) | Reasoning depth. Defaults to the config's `defaultEffort` (`"low"`) |
| `verbosity` | `"low"` \| `"medium"` \| `"high"` | OpenAI only | Response text verbosity |
| `reasoningSummary` | `"auto"` \| `"concise"` \| `"detailed"` \| `"none"` | OpenAI only | Reasoning summary output mode |
| `serviceTier` | `string` | OpenAI only | OpenAI/codex service tier |
| `timeoutMs` | positive integer, max `1_800_000` | Anthropic only | Server-side Claude Code process timeout in milliseconds. Defaults to 240 seconds |
| `imageGeneration` | `boolean` | OpenAI only, non-stream | Enables codex's built-in `image_generation` tool (see [below](#image-generation)) |
| `imageGenerationOptions` | `{ quality?, size? }` | OpenAI only | Image quality/size hints. `quality: "low" \| "medium" \| "high"`, `size: "1024x1024" \| "1024x1536" \| "1536x1024"` (defaults: `medium` / `1536x1024`) |
| `fallbackModels` | `string[]` | reserved | Reserved for future qgrid server-side fallback routing. Not functional yet and unrelated to Claude Code's Fable refusal fallback |

AI SDK's top-level `timeout` remains the overall client-side budget and is converted to an
`AbortSignal` before the custom provider runs. It does not expose the numeric timeout to qgrid.
Use `providerOptions.qgrid.timeoutMs` when the qgrid server's Claude Code process needs a different
limit. A client abort or disconnected non-streaming HTTP request also terminates the server-side
provider execution.

### Multi-turn prompt cache (sessionKey)

For multi-turn conversations, pass a single caller-side domain ID (game session ID, chat room ID, ...) as `sessionKey` and the provider routes the same conversation to the same codex thread, hitting the prompt cache. Thread coordinate issuance/storage/replay is handled inside the provider — the caller only passes the key.

```typescript
const { text } = await generateText({
  model: qgrid("openai/gpt-5.4-mini"),
  prompt: nextTurnPrompt,
  providerOptions: { qgrid: { sessionKey: "game-session-123" } },
});
```

- Threads expire after 10 minutes idle. On expiry or worker restart, the request automatically starts a cold thread instead of failing.
- Ignored for `anthropic/*` models (Claude Code spawns a fresh process per request, so there is no thread reuse).
- Can be disabled server-side with `QGRID_OPENAI_THREAD_REUSE=false`.

### Image Generation

OpenAI/codex route only, `generateText` only. Enables codex's built-in `image_generation` tool for that single request and returns the image through the AI SDK `files`.

```typescript
const result = await generateText({
  model: qgrid("openai/gpt-5.4"),
  prompt: "An illustration of a whale flying through space",
  providerOptions: {
    qgrid: {
      imageGeneration: true,
      imageGenerationOptions: { quality: "medium", size: "1536x1024" },
    },
  },
});

const image = result.files[0]; // mediaType: "image/png", base64
```

Reference images can be passed through normal AI SDK multimodal message parts:

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

- Rejected in `streamText` (non-stream only).
- Image-generation requests always run on a cold one-shot thread and are excluded from thread reuse.
- Reference images are sent as JSON data URLs. Compress or resize large photos before passing them in; oversized base64 inputs are rejected by the SDK. WebP/JPEG is recommended for photos.
- The image cost is an **estimate** based on the public `gpt-image-2` price table, recorded separately as `image_cost_usd` on the request log (codex does not expose exact image-tool usage).

## Telemetry Logger

To use the same request log dashboard with models that don't go through the qgrid provider (direct google/openai calls), pass `createQgridLogger` to `experimental_telemetry`.

```typescript
import { generateText } from "ai";
import { google } from "@ai-sdk/google";
import { createQgridLogger } from "@cartanova/qgrid-ai-sdk";

const { text } = await generateText({
  model: google("gemini-3-flash"),
  prompt: "Hello",
  experimental_telemetry: createQgridLogger({
    serverUrl: "http://localhost:44900",
  }),
});
```

Parallel calls, run separation, and telemetry activation are handled automatically.

### Logger configuration

```typescript
createQgridLogger({
  serverUrl: string;           // qgrid server address (required)
  projectName?: string;        // request_logs.project_name (default: QGRID_PROJECT_NAME env var)
  tokenName?: string;          // request_logs.token_name (default: "external")
  staleRunTimeoutMs?: number;  // watchdog timeout (default: 30 min, or the AI SDK timeout plus a grace period; 0 disables)
  onLogError?: (error: Error) => void;  // logging-failure callback
});
```

Everything except `serverUrl` is optional. With defaults in place, passing only `serverUrl` works.

To opt one generation out of request logging, set `providerOptions.qgrid.logger` to `false`.
The same option works for qgrid-provider calls and for external-provider calls observed by
`createQgridLogger`; tool execution and multi-step continuation still work normally.

```typescript
import { type QgridProviderOptions } from "@cartanova/qgrid-ai-sdk";

const { text } = await generateText({
  model: google("gemini-3-flash"),
  prompt: "Do not persist this request",
  providerOptions: {
    qgrid: { logger: false } satisfies QgridProviderOptions,
  },
  experimental_telemetry: createQgridLogger({ serverUrl: "http://localhost:44900" }),
});
```

External-provider request logs store model names as `provider/modelId`. If the provider reports
a different served model in the AI SDK response metadata, step and final log rows record that
observed model while retaining the requested model separately. This does not alter the AI SDK
runtime `response.modelId`. AI SDK adapter suffixes are normalized to the base provider, for
example `openai.responses` to `openai` and `anthropic.messages` to `anthropic`.

### Using alongside the qgrid provider

The `qgrid()` provider has its own lifecycle, so the logger automatically suppresses itself for qgrid calls. Mixing the qgrid provider and other providers in the same code does not double-log.

## Supported models

```typescript
type QgridSupportedModel =
  // OpenAI (based on codex app-server)
  | "openai/gpt-5.6-sol"
  | "openai/gpt-5.6-terra"
  | "openai/gpt-5.6-luna"
  | "openai/gpt-5.5"
  | "openai/gpt-5.4"
  | "openai/gpt-5.2"
  | "openai/gpt-5.4-mini"
  | "openai/gpt-5.3-codex"
  | "openai/gpt-5.3-codex-spark"
  // Anthropic
  | "anthropic/claude-fable-5"
  | "anthropic/claude-haiku-4-5"
  | "anthropic/claude-sonnet-4"
  | "anthropic/claude-sonnet-4-5"
  | "anthropic/claude-sonnet-4-6"
  | "anthropic/claude-sonnet-4-7"
  | "anthropic/claude-sonnet-5"
  | "anthropic/claude-opus-4"
  | "anthropic/claude-opus-4-1"
  | "anthropic/claude-opus-4-5"
  | "anthropic/claude-opus-4-6"
  | "anthropic/claude-opus-4-7"
  | "anthropic/claude-opus-4-8"
  | "anthropic/claude-opus-5"
```

### GPT-5.6 specifications

| Model | Context (qgrid/codex runtime) | Max output | Input / cached input / output per 1M tokens |
|---|---:|---:|---:|
| `openai/gpt-5.6-sol` | 372K | 128K | $5 / $0.50 / $30 |
| `openai/gpt-5.6-terra` | 372K | 128K | $2.50 / $0.25 / $15 |
| `openai/gpt-5.6-luna` | 372K | 128K | $1 / $0.10 / $6 |

All GPT-5.6 models support reasoning through `max`. The OpenAI native API spec is a 1.05M context window with 128K max output, but qgrid runs on the codex app-server subscription path, where all three models report a 372K context window (95% effective — about 353K of usable input) that cannot be raised by configuration. Prompts over 272K input tokens apply a 2x input and 1.5x output surcharge to the full request; cache writes cost 1.25x the uncached input rate.

`anthropic/claude-fable-5` has a 1M context window and 128K max output. Its standard prices per 1M tokens are $10 input, $1 cache read, $12.50 five-minute cache write, $20 one-hour cache write, and $50 output. qgrid preserves Claude's 5m/1h cache-creation breakdown and prices each TTL separately; only legacy responses without that breakdown fall back to the one-hour TTL automatically selected by Claude Code on subscription OAuth. Fable requires always-on adaptive thinking, so qgrid preserves adaptive thinking for this model.

`anthropic/claude-opus-5` has a default 1M context window and 128K max output. Its prices per 1M tokens are $5 input, $0.50 cache read, $6.25 five-minute cache write, $10 one-hour cache write, and $25 output. qgrid keeps Opus 5's default adaptive thinking behavior and uses `effort` to control reasoning depth. This also avoids the invalid `thinking: disabled` combination at `xhigh` or `max` effort.

Claude Code may automatically retry a Fable safety refusal on Opus 4.8. In that case, the AI SDK response's `response.modelId` and `providerMetadata.qgrid.model` identify Opus as the actual serving model. `providerMetadata.qgrid.requestedModel` remains Fable, and `providerMetadata.qgrid.modelFallbacks` contains the refusal fallback history. The metadata also exposes `costSource` and the 5m/1h cache-write token split.

`openai/gpt-5.3-codex-spark` remains a research preview without final published per-token rates. qgrid therefore reports its generic fallback estimate rather than presenting that estimate as official pricing.

## Configuration

```typescript
qgrid(modelId, {
  serverUrl?: string;      // qgrid server address (default: QGRID_URL env var, then http://localhost:44900)
  defaultEffort?: string;  // default effort (default: "low")
  projectName?: string;    // request_logs.project_name (default: QGRID_PROJECT_NAME env var)
});
```

If multiple projects/workflows share one qgrid server, set `QGRID_PROJECT_NAME`. It lets you filter request logs by project in the dashboard and compare token/cost/cache metrics per workload. The config-level `projectName` is an override for callers that need a different label.

## Environment variables

| Variable | Description | Default |
|---|---|---|
| `QGRID_URL` | qgrid server address | `http://localhost:44900` |
| `QGRID_PROJECT_NAME` | request log project name (provider and logger) | (empty) |

## Notes

- Sampling parameters such as `temperature` and `maxOutputTokens` are ignored — the CLI runtimes (OpenAI: codex app-server, Anthropic: Claude Code) do not support them.
- Structured output is server-enforced only for top-level `object` schemas. Top-level `array` falls back to client-side parsing.
- `tools` and a structured output schema cannot be used together on the server. When tools are present, the schema is not forwarded and the AI SDK parses the final text client-side.

## Requirements

- Node.js >= 20
- AI SDK v6 (`ai@^6.0.0`)
- A running qgrid server
