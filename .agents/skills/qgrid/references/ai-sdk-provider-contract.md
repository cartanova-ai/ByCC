# AI SDK Provider Contract

Use this reference before changing `packages/ai-sdk`.

## Active public surface

`packages/ai-sdk` is the active public SDK package. `packages/sdk` is deprecated and context-only.

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

`providerOptions.qgrid` supports:

- `sessionKey`: OpenAI thread reuse key. Disabled for Anthropic models.
- `effort`
- `verbosity`: OpenAI/Codex route only.
- `reasoningSummary`: OpenAI/Codex route only.
- `serviceTier`: OpenAI/Codex route only.
- `fallbackModels`: reserved for future fallback routing.
- `imageGeneration`: OpenAI/Codex non-stream only. Enables Codex's built-in `image_generation` tool for that request.
- `imageGenerationOptions`: optional image quality/size hints and cost-estimation basis. Current supported values are `quality: "low" | "medium" | "high"` and `size: "1024x1024" | "1024x1536" | "1536x1024"`.

`providerOptions.qgrid` does not currently support `projectName` or `project_name`. Prefer `QGRID_PROJECT_NAME` for the default project label; use config `projectName` only when a caller needs to override that default.

## OpenAI/Codex Fast mode

qgrid supports Codex Fast mode per request through `providerOptions.qgrid.serviceTier`. Pass `"fast"`; qgrid forwards it through the OpenAI route to Codex `turn/start`, and Codex normalizes the legacy `fast` value to the upstream `priority` service tier.

```ts
const result = await generateText({
  model: qgrid("openai/gpt-5.6-terra"),
  prompt,
  providerOptions: {
    qgrid: {
      serviceTier: "fast",
    },
  },
});
```

Fast mode contract:

- It is OpenAI/Codex-only. Do not send it to `anthropic/*` models.
- It works on both `generateText` and `streamText`; image generation remains non-stream for unrelated reasons.
- Omit `serviceTier` for normal/default routing. qgrid's current API accepts `"fast"` and `"flex"`; callers should not send Codex's normalized `"priority"` value directly.
- qgrid is a pass-through for this selection. Codex applies the tier only when its Fast mode feature is enabled and the selected model advertises support; otherwise Codex can omit the unsupported tier.
- Fast mode changes upstream service-tier routing, not qgrid worker capacity. It does not change WPT, client concurrency, queue behavior, or worker autoscaling.
- Do not promise a fixed latency improvement. Verify TTFT, duration, throughput, and quota consumption with a workload-specific A/B test.

## Request construction

The provider sends `POST /api/qgrid/query` for generate and `prepareStream` plus SSE for stream.

Payload responsibilities:

- Extract current prompt, system prompt, and history from AI SDK prompt messages.
- Convert AI SDK function tools to qgrid tools.
- Send `jsonSchema` only when no tools are present and response format top-level schema is `object`.
- Send `history` as JSON string when prior messages exist.
- Send `projectName` when configured.
- Use `logMode: "run"` for tool-call loops.
- Preserve and resend `runContext` for tool-call follow-ups.
- Store/resend OpenAI `threadCoord` by `sessionKey`.
- Send `imageGeneration` and `imageGenerationOptions` when configured.
- Send AI SDK multimodal image/file message parts as qgrid `input` only when `imageGeneration` is enabled. Normal non-image-generation calls keep `user_prompt` text-only and do not forward image input.
- Reject oversized reference-image data URLs before the request leaves the SDK. Reference images travel as JSON data URLs; callers should compress/resize large photos, preferably to WebP/JPEG.

Tools and `jsonSchema` cannot be used together at qgrid dispatcher level.

When tools are present, qgrid sends tool definitions to the server as `tools`; it does not send them to OpenAI or Anthropic as native provider tools. The server converts them into a strict structured-output schema and maps the model's structured result back into AI SDK `tool-call` content.

Image generation is different from AI SDK client tools: it is an opt-in Codex-hosted tool exposed by qgrid through `providerOptions.qgrid.imageGeneration`. Use `generateText`; `streamText` rejects image generation before opening the stream.

Reference images for image generation use normal AI SDK multimodal message parts. The provider wraps image/file base64 as `data:${mediaType};base64,...` qgrid `input` items. This is intentionally scoped to image-generation requests, not general vision/chat behavior.

## Response mapping

qgrid response content maps to AI SDK content:

- qgrid `text` -> AI SDK text content.
- qgrid `tool-call` -> AI SDK tool-call content.
- qgrid `image` -> AI SDK file content with `mediaType: "image/png"`.

`finishReason` maps `tool-calls` when qgrid returns tool calls.

When `imageGeneration` was requested and the server returns no image part, the AI SDK provider throws a version-skew/error guard instead of silently accepting text-only output.

Usage maps qgrid standard usage into AI SDK V3 usage:

- `inputTokens.total = input_tokens`
- `inputTokens.cacheRead = cache_read_input_tokens`
- `inputTokens.cacheWrite = cache_creation_input_tokens`
- `inputTokens.noCache = max(input - cacheRead - cacheWrite, 0)`
- `outputTokens.total = output_tokens`

## Anthropic sessionKey guard

Do not store or replay `sessionKey` thread coordinates for `anthropic/*` models. Tests cover this because Anthropic fresh-spawn runtime cannot safely use Codex-style thread reuse.

## Logger integration

`createQgridLogger` records external provider calls into qgrid request logs. It skips qgrid provider calls to avoid double-logging. When changing logger behavior, preserve stale-run fallback because AI SDK telemetry lacks a reliable error hook for all failure modes.
