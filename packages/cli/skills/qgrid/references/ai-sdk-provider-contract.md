# AI SDK Provider Contract

Use this reference before changing `packages/ai-sdk`.

## Active public surface

`packages/ai-sdk` is the active public SDK package. The old v1 SDK (`@cartanova/qgrid-sdk`) has been removed from the repository.

qgrid's custom provider implements the AI SDK `LanguageModelV3` contract. General usage should follow the AI SDK docs and normal AI SDK APIs such as `generateText`, `streamText`, tools, structured output, and telemetry. Do not re-document generic AI SDK usage in qgrid-specific docs unless the behavior differs. qgrid docs and this skill should focus on qgrid-specific config, `providerOptions.qgrid`, request logging, runtime routing, cache/session behavior, and provider limitations.

For tool calling, qgrid intentionally follows the AI SDK interface while implementing provider calls through qgrid structured-output emulation. Read `tool-calling-and-multiturn.md` before changing tool behavior, `stopWhen`/multi-step behavior, or tool-call request logs.

Main files:

- `packages/ai-sdk/src/index.ts`: `qgrid()` provider implementation.
- `packages/ai-sdk/src/index.types.ts`: public config/options/types.
- `packages/ai-sdk/src/utils.ts`: prompt/history/tool conversion.
- `packages/ai-sdk/src/logger.ts`: telemetry logger integration.
- `packages/ai-sdk/src/qgrid.constant.ts`: defaults and warnings.

## Provider config

`qgrid(modelId, config)` supports:

- `serverUrl`: default `process.env.QGRID_URL`, then `http://localhost:44900`.
- `defaultEffort`: default `low`.
- `projectName`: default `process.env.QGRID_PROJECT_NAME`.

Strongly recommend setting `QGRID_PROJECT_NAME` in the environment for real workloads. The config-level `projectName` override is valid, but the env var is the preferred project-wide default. It is stored as `request_logs.project_name` and makes high-volume request logs usable: operators can filter by project/workflow, identify which task produced which request, compare token/cache/cost/TTFT metrics by workload, and debug noisy callers without scanning prompts manually.

Use camelCase `projectName` in TypeScript and qgrid API payloads. `project_name` is the database/Sonamu request-log field name, not an AI SDK provider option.

Setup agents should treat a missing project label as an actionable configuration gap. When installing or wiring qgrid for a local app, inspect the target app's env/config. If neither `QGRID_PROJECT_NAME` nor qgrid provider/logger config `projectName` is present, ask the user for a stable project or workflow name, then add it using the project's normal env/config pattern. A repo or package name is an acceptable default only when it is clearly the user's intended workload label.

## Provider options

qgrid-specific behavior is controlled through `providerOptions.qgrid`. Explain these options precisely because they are qgrid's extension point beyond normal AI SDK usage.

AI SDK declares the outer `providerOptions` as a generic JSON record, so it does not infer qgrid-specific keys or literal values. qgrid exports `QgridProviderOptions` for the inner `providerOptions.qgrid` value. Import it and put the `satisfies` check at that inner boundary:

```ts
import { generateText } from "ai";
import { qgrid, type QgridProviderOptions } from "@cartanova/qgrid-ai-sdk";

const result = await generateText({
  model: qgrid("anthropic/claude-fable-5"),
  prompt,
  providerOptions: {
    qgrid: {
      effort: "high",
    } satisfies QgridProviderOptions,
  },
});
```

Do not write `providerOptions: { ... } satisfies QgridProviderOptions`: the exported type describes the nested qgrid options object, not AI SDK's outer provider-name map. Use this typed pattern in qgrid setup guidance and examples so misspelled keys and invalid option values fail at compile time.

`providerOptions.qgrid` supports:

- `tokenName`: strict active-token targeting for both providers. Include the provider prefix and
  match it to the model (`anthropic/yds` with `anthropic/*`, for example). Missing, inactive, or
  over-threshold targets fail without falling back to another token. An explicitly empty value is
  rejected by the SDK before transport; omission keeps weighted round-robin routing.
- `logger`: request-log switch. Omitted or `true` is the default and enables qgrid logging; `false` guarantees that generation creates zero qgrid request-log rows.
- `sessionKey`: source for model-scoped opaque OpenAI prompt-cache affinity. Disabled for Anthropic models.
- `effort`
- `verbosity`: OpenAI/Codex route only.
- `reasoningSummary`: OpenAI/Codex route only.
- `serviceTier`: OpenAI/Codex route only.
- `timeoutMs`: Anthropic server-side Claude Code process timeout in milliseconds. It must be a positive integer no greater than 30 minutes and defaults to 240 seconds. For non-stream `generateText`, the SDK derives request-scoped Undici `headersTimeout` and `bodyTimeout` values as `timeoutMs + 60_000` without changing the process-global dispatcher.
- `fallbackModels`: reserved for future qgrid server-side fallback routing. It is not the Fable 5 safety-refusal fallback, which is owned by Claude Code upstream.
- `imageGeneration`: OpenAI/Codex non-stream only. Enables Codex's built-in `image_generation` tool for that request.
- `imageGenerationOptions`: optional image quality/size hints and cost-estimation basis. Current supported values are `quality: "low" | "medium" | "high"` and `size: "1024x1024" | "1024x1536" | "1536x1024"`.

`providerOptions.qgrid` does not currently support `projectName` or `project_name`. Prefer `QGRID_PROJECT_NAME` for the default project label; use config `projectName` only when a caller needs to override that default.

AI SDK's standard top-level `timeout` is still the overall client-side budget. AI SDK converts it
to the `abortSignal` in `LanguageModelV3CallOptions`, so a custom provider cannot recover the
original numeric duration. Do not infer or duplicate that timeout. Use
`providerOptions.qgrid.timeoutMs` for the server-side Claude Code limit. The SDK also uses that
explicit value to keep its own non-stream HTTP transport budget 60 seconds above the server
limit; this prevents Undici's 300-second default from cutting off long Anthropic requests first.
Recommend setting the AI SDK timeout high enough to include network and server overhead. Client
cancellation and non-streaming HTTP disconnects propagate separately through `AbortSignal`.

Transport failures preserve their root category in the public error message. In particular,
`UND_ERR_HEADERS_TIMEOUT` reports the effective transport budget and `ECONNREFUSED` reports a
connection refusal instead of leaving both as an undifferentiated `fetch failed`.

## Request logging

Request logging is enabled by default. Opt out per generation with the typed qgrid option:

```ts
const result = await generateText({
  model: qgrid("openai/gpt-5.6-terra"),
  prompt,
  providerOptions: {
    qgrid: {
      logger: false,
    } satisfies QgridProviderOptions,
  },
});
```

`logger: false` affects observability only. Generation, streaming, AI SDK client tool execution, multi-step continuation, and OpenAI cache affinity continue normally. When `createQgridLogger` is also installed, it reads the same option and suppresses its external-provider telemetry lifecycle for that generation; qgrid provider calls are always skipped by the telemetry integration to prevent double logging.

For raw qgrid query/stream payloads, the corresponding input is top-level `logger?: boolean`, also defaulting to `true`. The old `logMode` input has been removed. Because the wire schema accepts unknown keys, a legacy payload containing `logMode` is accepted but the field is ignored. It must not appear in new code. Migrate callers as follows:

- Omitted logging mode or `"auto"`: remove it; omit `logger` or send `logger: true`.
- `"run"`: remove it; the server now infers a continued tool run from `runContext`, tool results, and the provider finish reason.
- `"none"`: replace it with `logger: false`.

## OpenAI/Codex Fast mode

qgrid supports Codex Fast mode per request through `providerOptions.qgrid.serviceTier`. Pass `"fast"`; qgrid forwards it as `service_tier: "priority"` in the direct OpenAI Responses request.

```ts
const result = await generateText({
  model: qgrid("openai/gpt-5.6-terra"),
  prompt,
  providerOptions: {
    qgrid: {
      serviceTier: "fast",
    } satisfies QgridProviderOptions,
  },
});
```

Fast mode contract:

- It is OpenAI/Codex-only. Do not send it to `anthropic/*` models.
- It works on both `generateText` and `streamText`; image generation remains non-stream for unrelated reasons.
- Omit `serviceTier` for normal/default routing. qgrid's current API accepts `"fast"` and `"flex"`; callers should not send Codex's normalized `"priority"` value directly.
- qgrid is a pass-through for this selection. Codex applies the tier only when its Fast mode feature is enabled and the selected model advertises support; otherwise Codex can omit the unsupported tier.
- Fast mode changes upstream service-tier routing only. It does not change token weights or client concurrency.
- Do not promise a fixed latency improvement. Verify TTFT, duration, throughput, and quota consumption with a workload-specific A/B test.

## Request construction

The provider sends `POST /api/qgrid/query` for generate and `prepareStream` plus SSE for stream.

Payload responsibilities:

- Extract current prompt, system prompt, and history from AI SDK prompt messages.
- Convert AI SDK function tools to qgrid tools.
- Send `jsonSchema` whenever the response format top-level schema is `object`, including requests that also contain tools.
- Send `history` as JSON string when prior messages exist.
- Send `projectName` when configured.
- Send `tokenName` when configured so generate and stream use the same strict target.
- Send `logger: false` when the per-call option disables request logging; otherwise rely on the server default.
- Preserve and resend `runContext` for tool-call follow-ups.
- Let the server infer single-turn completion versus an open tool-call run. Logging-disabled tool calls still use the SDK's local pending-call correlation and continue without a request-log id.
- Derive/store/resend opaque OpenAI affinity coordinates by `sessionKey`.
- Send `imageGeneration` and `imageGenerationOptions` when configured.
- Send AI SDK multimodal image/file message parts as qgrid `input` only when `imageGeneration` is enabled. Normal non-image-generation calls keep `user_prompt` text-only and do not forward image input.
- Reject oversized reference-image data URLs before the request leaves the SDK. Reference images travel as JSON data URLs; callers should compress/resize large photos, preferably to WebP/JPEG.

Tools and `jsonSchema` can be used together as of qgrid 2.5.4. On OpenAI the
server composes them into one strict action envelope enforced by constrained
decoding; on Anthropic (SON-532) the same envelope contract is rendered as text
at the end of the system prompt and the reply is validated by `parseEnvelope`.
`toolChoice` is not part of the current qgrid wire contract and must not be
described as supported.

Before provider dispatch, qgrid validates caller output schemas and every tool
input schema with an iterative preflight. Output/tool schema serialization, tool
names, descriptions, JSON escaping, and composition framing share an aggregate
512 KiB UTF-8 budget. Schema JSON values are limited to 20,000 in aggregate, and
each schema is limited to depth 128. Malformed, unsupported top-level output, or
over-budget schemas fail with HTTP 400 before request-log creation or stream ID
allocation. On OpenAI the fully composed and strictified schema is checked again
against the 512 KiB budget. Anthropic performs only this syntax/complexity
preflight — no strictify, no argv ceiling (the old 64 KiB `--json-schema` limit
is gone; large schema contracts ride the system-prompt file branch).

OpenAI normalizes positional tuple schemas in supported positive schema
positions and enforces their positional constraints. Tuples in negative,
conditional, or otherwise non-normalizable schema positions fail with HTTP 400
instead of being rewritten with changed semantics. References from those
positions fail for the same reason because definitions are normalized globally.
Tuple nodes must explicitly declare `type: "array"`; express nullable tuples
with an `anyOf` array/null branch. These normalization restrictions are
OpenAI-only: the Anthropic route injects the schema verbatim as prompt text, so
positional tuples and arbitrary `$ref` forms pass through unchanged.

On OpenAI, structured schemas accept only local root-relative JSON Pointer
`$ref` values targeting the document root or a chain of `$defs`/`definitions`
entry roots. References into properties, tuple internals, conditionals, or
literal values fail with HTTP 400 because normalization can move or rewrite
those targets. Resource IDs, anchors, external refs, dynamic refs, and recursive refs are also
rejected.

When tools are present, qgrid sends tool definitions to the server as `tools`; it does not send them to OpenAI or Anthropic as native provider tools. The server converts them into a strict structured-output schema and maps the model's structured result back into AI SDK `tool-call` content.

Image generation is different from AI SDK client tools: it is an opt-in Codex-hosted tool exposed by qgrid through `providerOptions.qgrid.imageGeneration`. Use `generateText`; `streamText` rejects image generation before opening the stream.

Reference images for image generation use normal AI SDK multimodal message parts. The provider wraps image/file base64 as `data:${mediaType};base64,...` qgrid `input` items. This is intentionally scoped to image-generation requests, not general vision/chat behavior.

## Response mapping

qgrid response content maps to AI SDK content:

- qgrid `text` -> AI SDK text content.
- qgrid `tool-call` -> AI SDK tool-call content.
- qgrid `image` -> AI SDK file content with `mediaType: "image/png"`.

`finishReason` maps `tool-calls` when qgrid returns tool calls.

For tools plus structured output, qgrid serializes the final schema-constrained
`answer` as JSON text. AI SDK then parses and validates that text into
`Output.object`'s `output`. This path requires both server and SDK 2.5.4 or later.

When `imageGeneration` was requested and the server returns no image part, the AI SDK provider throws a version-skew/error guard instead of silently accepting text-only output.

For a successful Fable 5 refusal fallback:

- `response.modelId` and `providerMetadata.qgrid.model` are the actual serving model, normally `claude-opus-4-8`.
- `providerMetadata.qgrid.requestedModel` remains `claude-fable-5`.
- `providerMetadata.qgrid.modelFallbacks` preserves the refusal route and optional category/explanation.
- `providerMetadata.qgrid.costSource` reports whether cost came from Claude Code or qgrid's pricing table. Prefer the provider-reported combined cost for this path.

Do not expose the requested Fable model as `response.modelId` after Opus served the answer, and do not map this upstream safety behavior onto the reserved `providerOptions.qgrid.fallbackModels` option.

Usage maps qgrid standard usage into AI SDK V3 usage:

- `inputTokens.total = input_tokens`
- `inputTokens.cacheRead = cache_read_input_tokens`
- `inputTokens.cacheWrite = cache_creation_input_tokens`
- `inputTokens.noCache = max(input - cacheRead - cacheWrite, 0)`
- `outputTokens.total = output_tokens`

## Anthropic sessionKey guard

Do not store or replay `sessionKey` affinity coordinates for `anthropic/*` models. Anthropic fresh-spawn runtime uses its own prefix-cache behavior.

## Logger integration

`createQgridLogger` records external provider calls into qgrid request logs. It skips qgrid provider calls to avoid double-logging, and it skips any external-provider generation whose `providerOptions.qgrid.logger` is `false`. This makes `logger: false` a single opt-out that produces zero native or telemetry request logs without changing the model call itself. When changing logger behavior, preserve stale-run fallback because AI SDK telemetry lacks a reliable error hook for all failure modes.

For external providers, the logger reads AI SDK's provider-neutral `onStart.output.responseFormat`. JSON output modes send `isStructured: true` plus the serialized schema when present; ordinary text sends `isStructured: false` and `jsonSchema: null`. A succeeded structured run also sends `responseJsonOk`, based only on whether the final response text parses as JSON. Qgrid does not duplicate caller-side Zod/schema validation. These lifecycle fields are optional on the server so older SDK clients remain compatible.
