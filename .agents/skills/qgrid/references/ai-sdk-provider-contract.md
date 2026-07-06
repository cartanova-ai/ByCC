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

Strongly recommend setting `projectName` for real workloads even though it is optional. It is stored as `request_logs.project_name` and makes high-volume request logs usable: operators can filter by project/workflow, identify which task produced which request, compare token/cache/cost/TTFT metrics by workload, and debug noisy callers without scanning prompts manually.

## Provider options

qgrid-specific behavior is controlled through `providerOptions.qgrid`. Explain these options precisely because they are qgrid's extension point beyond normal AI SDK usage.

`providerOptions.qgrid` supports:

- `sessionKey`: OpenAI thread reuse key. Disabled for Anthropic models.
- `effort`
- `verbosity`: OpenAI/Codex route only.
- `reasoningSummary`: OpenAI/Codex route only.
- `serviceTier`: OpenAI/Codex route only.
- `fallbackModels`: reserved for future fallback routing.
- `imageGeneration`: in progress, OpenAI/Codex non-stream only.

If a per-call project-name option exists in this surface, treat it the same way as config `projectName`: optional but strongly recommended for production or repeated experiments so request logs and metrics can be grouped by task/workload.

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

Tools and `jsonSchema` cannot be used together at qgrid dispatcher level.

When tools are present, qgrid sends tool definitions to the server as `tools`; it does not send them to OpenAI or Anthropic as native provider tools. The server converts them into a strict structured-output schema and maps the model's structured result back into AI SDK `tool-call` content.

## Response mapping

qgrid response content maps to AI SDK content:

- qgrid `text` -> AI SDK text content.
- qgrid `tool-call` -> AI SDK tool-call content.
- qgrid `image` -> AI SDK file content with `mediaType: "image/png"`.

`finishReason` maps `tool-calls` when qgrid returns tool calls.

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
