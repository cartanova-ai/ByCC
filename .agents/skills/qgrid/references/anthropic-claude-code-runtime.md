# Anthropic Claude Code Runtime

Use this reference before changing Anthropic provider behavior, Claude Code spawn args/env, stream-json adaptation, structured output, 1M context behavior, token routing, OAuth refresh, or quota handling.

## Contents

- Process model
- Token routing
- OAuth refresh
- Spawn args
- Spawn env
- Config isolation
- Input adaptation
- Output adaptation
- Fable refusal fallback
- Structured output
- 1M context

## Process model

Anthropic uses fresh Claude Code process spawn per request. It does not use a persistent worker pool.

- Dispatcher: `packages/api/src/utils/providers/anthropic/anthropic-dispatcher.ts`.
- Session runner: `packages/api/src/utils/providers/anthropic/claude-session.ts`.
- Stream adapter: `packages/api/src/utils/providers/anthropic/stream-json-adapter.ts`.
- Constants/model normalization: `packages/api/src/utils/providers/anthropic/anthropic-constants.ts`.
- Process command: `claude -p ...`.
- Each request gets a fresh UUID `--session-id`.
- `workerId` is `tokenId`.
- `epoch` is always `0`.

The emitted `threadCoord` lets qgrid keep a shared response shape, but AI SDK disables `sessionKey` storage/replay for `anthropic/*` models. Do not implement Anthropic cache by pretending Claude sessions are reused unless the runtime design changes.

## Token routing

Anthropic tokens live in an in-memory `Map<tokenId, PooledToken>`.

- Startup loads active Anthropic tokens from DB.
- Token subscriber events add/update/remove entries.
- Periodic reconcile replaces pool contents from active DB rows.
- Request selection is least-used plus round-robin tie-break.
- Request count is incremented before awaiting execution so concurrent requests spread across tokens.

Quota threshold:

- `quota_threshold` is checked through Anthropic quota usage.
- Lookup failure is fail-open.
- If all eligible tokens exceed threshold, throw `QuotaThresholdExceededError`.

## OAuth refresh

Before spawning Claude, qgrid refreshes access tokens when expiration is within 60 seconds and a refresh token exists.

Refresh is attempted through `QgridFrame.refreshToken` with provider set to `anthropic`. Refresh failure is logged and the current access token is still tried.

## Spawn args

`buildClaudeArgs` constructs Claude Code flags:

```text
claude -p
  --tools ""
  --allowed-tools StructuredOutput        # only when jsonSchema exists
  --disallowedTools Monitor PushNotification RemoteTrigger
  --input-format stream-json
  --output-format stream-json
  --verbose
  --include-partial-messages              # streaming path only
  --permission-mode bypassPermissions
  --setting-sources project
  --model <canonical-model-or-1m-suffix>
  --system-prompt <text>                  # small system prompt
  --system-prompt-file <path>             # large system prompt
  --thinking disabled                       # omitted for Fable 5
  --effort <effort-or-low>
  --disable-slash-commands
  --session-id <uuid>
  --json-schema <schema>                  # only when jsonSchema exists
```

Important details:

- `--tools ""` blocks normal tools. With structured output, only `StructuredOutput` is allowed.
- `--setting-sources project` plus seeded settings isolates user configuration.
- `--system-prompt` or `--system-prompt-file` is always supplied. Omitting it would allow Claude Code default system prompt injection.
- Large system prompts over 64 KiB are written to a temporary file to avoid argv `E2BIG`.
- `--thinking disabled`, `MAX_THINKING_TOKENS=0`, and adaptive thinking env suppression keep thinking off for existing models. Fable 5 requires always-on adaptive thinking, so qgrid omits all three suppressors for it.

## Spawn env

qgrid builds a fresh env whitelist. Do not spread `process.env` into Claude child env.

Included env:

- `PATH`
- `TMPDIR`
- `CLAUDE_CODE_OAUTH_TOKEN`
- `CLAUDE_CONFIG_DIR`
- `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`
- `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1` except for Fable 5
- `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`
- `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`
- `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1`
- `CLAUDE_CODE_DISABLE_WORKFLOWS=1`
- `CLAUDE_CODE_ATTRIBUTION_HEADER=0`
- `MAX_THINKING_TOKENS=0` except for Fable 5
- `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` when model does not support qgrid's 1M path
- `MAX_STRUCTURED_OUTPUT_RETRIES` for structured output only

Never pass `ANTHROPIC_API_KEY` or inherited auth env vars to child processes. OAuth must flow through `CLAUDE_CODE_OAUTH_TOKEN`.

## Config isolation

- Shared cwd: `/tmp/qgrid-anthropic`.
- Project settings file: `/tmp/qgrid-anthropic/.claude/settings.json`, written as `{}`.
- Per-token config dir: `/tmp/qgrid-anthropic-config/${tokenId}`.
- qgrid writes `{}` to both `.claude.json` and `settings.json` inside the per-token config dir before each run.

This blocks user-scope Claude settings, hooks, memory, and token cross-contamination as much as the current Claude Code interface allows.

## Input adaptation

qgrid sends Claude stdin as JSONL with `--input-format stream-json`.

- Current input is the only executable user line.
- Prior conversation history is flattened into a single assistant context line prefixed with `Prior conversation context:`.
- Function calls and function outputs from AI SDK history are flattened into text.
- Each JSONL line is decorated with `session_id`, `uuid`, and `parent_tool_use_id: null`.

This is not equivalent to persistent Claude session reuse. It is full-history replay through a fresh process.

## Output adaptation

Claude stdout JSONL is parsed by `stream-json-adapter.ts`.

- Text mode streams `text_delta`.
- Structured mode streams `input_json_delta` and preserves `StructuredOutput` tool input as final text.
- `result` lines provide final text, usage, duration, cost, subtype, and terminal reason.
- Non-success subtype, `is_error`, or `terminal_reason: model_error` is treated as an error.
- Quota exhaustion is detected when text starts with `You've hit`.

Anthropic native usage categories are mutually exclusive. qgrid normalizes them into its provider-standard shape by setting:

```text
inputTokens = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
cachedInputTokens = cache_read_input_tokens
cacheCreationInputTokens = cache_creation_input_tokens
cacheCreationInputTokens5m = cache_creation.ephemeral_5m_input_tokens
cacheCreationInputTokens1h = cache_creation.ephemeral_1h_input_tokens
```

## Fable refusal fallback

Fable 5 runs upstream safety classifiers. A refusal is a successful HTTP response with
`stop_reason: "refusal"`, not an HTTP/provider error, and can happen before output or after
partial streamed output. Claude Code handles the refusal fallback and can retry on Opus 4.8.
This is distinct from the CLI `--fallback-model` flag, which is for overload on the default
model. qgrid does not configure either mechanism or add another retry.

The stream adapter must preserve all observable routing evidence:

- `system.subtype = "model_refusal_fallback"` provides the original/fallback models and refusal details.
- `assistant.message.model` identifies the model that produced that message.
- `usage.iterations` contains the original `message` and `fallback_message` when available.
- Treat `stop_reason`, rather than `stop_details` or empty content, as the authoritative refusal signal. Category and explanation are optional metadata.
- `model_refusal_no_fallback` or a terminal `stop_reason: "refusal"` is an error, even if the outer result subtype says `success`. A successfully served fallback has a non-refusal terminal reason and a `fallback_message` iteration.

`QueryOutput.model` is the actual serving model. `requestedModel` and `modelFallbacks` preserve
the caller's requested model and routing history. Because qgrid uses a fresh Claude Code process
for each request, any Claude Code session-sticky fallback state does not carry to the next request;
each new Fable request may independently refuse and fall back again.

Cost and usage must follow the upstream combined result. Prefer Claude Code's `total_cost_usd` and
preserve `usage.iterations` only as attribution evidence; do not independently price every iteration
and add them together. An upstream pre-output refusal is not billed, while work completed before a
mid-stream refusal can be billed. Upstream fallback handling applies fallback credit where applicable,
so a qgrid-side retry would risk duplicate work and incorrect cache-write billing.

Upstream references:

- [Refusals and fallback](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback)
- [Fallback credit](https://platform.claude.com/docs/en/build-with-claude/fallback-credit)
- [Claude Code CLI `--fallback-model`](https://code.claude.com/docs/en/cli-reference)

## Structured output

qgrid strictifies schemas before provider dispatch. Claude Code `--json-schema` is not grammar-constrained decoding; it is a `StructuredOutput` tool plus post-validation behavior. Keep schemas strict and preserve error signaling for failed structured-output attempts.

`MAX_STRUCTURED_OUTPUT_RETRIES` defaults to `1` for structured Anthropic calls and is clamped to at least 1. Avoid setting it to 0; Claude Code can fail before emitting a useful attempt.

## 1M context

Model normalization strips provider prefix and `[1m]` for canonical model/cost keys.

qgrid's exact 1M support set currently includes:

- `claude-fable-5`
- `claude-sonnet-5`
- `claude-sonnet-4-6`
- `claude-opus-4-6`
- `claude-opus-4-8`

Models requiring CLI `[1m]` suffix:

- `claude-sonnet-4-6`
- `claude-opus-4-6`

Unsupported `[1m]` suffixes throw early.
