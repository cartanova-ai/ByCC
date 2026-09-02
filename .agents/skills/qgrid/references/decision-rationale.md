# Decision Rationale

Use this reference when the question is "why is qgrid designed this way?" or before changing an established runtime contract. Current code is the source of truth for behavior; repo docs are the source of truth for the decision trail.

Do not copy these notes blindly into implementation. Use them to find the relevant docs, then inspect the current code and tests.

## Contents

- AI SDK provider boundary
- Tool calling and request-log lifecycle
- OpenAI/Codex runtime
- Anthropic/Claude Code runtime
- Token sync and quota thresholds
- Weighted token routing
- Request logs, metrics, and dashboard
- CLI packaging and server boot
- Image generation

## AI SDK Provider Boundary

Sources:

- `docs/plans/2026-05-07-feat-qgrid-ai-sdk-provider-plan.md`
- `docs/solutions/conventions/qgrid-provider-options-boundary.md`
- `docs/plans/2026-05-26-refactor-ai-sdk-wrapper-correlation-boundary-plan.md`

Key decisions:

- `packages/ai-sdk` is the active public SDK. The v1 SDK (`packages/sdk`) was deprecated in 2026-05 and removed from the repository in 2026-07; it remains only as a deprecated npm artifact.
- qgrid's AI SDK provider follows the AI SDK `LanguageModelV3` contract. Generic usage belongs to AI SDK docs; qgrid-specific docs should focus on qgrid routing, logging, cache/session behavior, and `providerOptions.qgrid`.
- qgrid-specific options live under `providerOptions.qgrid`, not under provider-specific namespaces such as `providerOptions.openai`. Consumers should not need to branch on Codex versus Claude internals.
- AI SDK exposes the outer `providerOptions` as a generic JSON record. `QgridProviderOptions` intentionally types the nested `providerOptions.qgrid` value, and examples should apply `satisfies` there to restore qgrid-specific inference without replacing AI SDK's outer contract.
- AI SDK's standard `timeout` owns the client-side total budget and reaches custom providers only as an `AbortSignal`. `providerOptions.qgrid.timeoutMs` separately owns the Anthropic server-side Claude process timer. For non-stream calls, the qgrid SDK may derive its own request-scoped Undici header/body budget from that explicit qgrid value (`timeoutMs + 60s`), but must not mutate the global dispatcher or pretend the original AI SDK timeout number is available.
- `projectName` is provider config/payload camelCase. `project_name` is the Sonamu/database request-log column. Prefer `QGRID_PROJECT_NAME` as the project-wide default so request logs and metrics remain filterable at volume.
- `fallbackModels` may exist as a typed future option, but it is not a server wire contract until the server implements fallback routing. Do not forward it as behavior just because the type exists.
- Fable refusal fallback is an upstream Claude Code safety path to another Opus model (currently Opus 5 or Opus 4.8 by refusal category), not qgrid's reserved `fallbackModels` feature or Claude Code's overload-only `--fallback-model` flag. qgrid observes and reports the actual route and provider cost; it must not retry again or hardcode the target.
- The SDK should stay a thin adapter. Server APIs own request-log lifecycle, provider dispatch, structured-output emulation, and provider runtime details.
- Request logging defaults to enabled. `providerOptions.qgrid.logger: false` is the single per-generation opt-out for both native qgrid logs and `createQgridLogger` telemetry logs; it must not alter generation or tool behavior.

## Tool Calling And Request-Log Lifecycle

Sources:

- `docs/plans/2026-05-07-feat-qgrid-ai-sdk-provider-plan.md`
- `docs/plans/2026-05-20-feat-request-log-run-lifecycle-api-plan.md`
- `docs/plans/2026-05-26-refactor-ai-sdk-wrapper-correlation-boundary-plan.md`
- `docs/solutions/tooling-decisions/anthropic-structured-stream-keep-required-and-fail-honestly.md`

Key decisions:

- qgrid tool calling is intentionally implemented through structured-output emulation, not native provider tool use. The provider call returns a structured action with tool calls; the AI SDK loop executes tools and sends follow-up turns.
- Tools and `jsonSchema` share one provider structured-output slot by composing
  an action envelope on every turn. Its final `answer` branch embeds the user's
  schema; its `tool_call` branch carries emulated AI SDK calls. This keeps final
  output constrained even when tools are available but never called.
- Final output is identified by `action: "answer"`, not by tool presence or turn
  count. Tools-only and tools-plus-schema responses use the same strict envelope
  decoder. Tools-only answers return the validated string verbatim; structured
  answers are serialized as JSON text for AI SDK `Output.object` parsing.
  Malformed envelopes fail instead of being rescued as text.
- AI SDK `toolChoice` remains outside qgrid's wire contract. Do not imply that
  qgrid transports or enforces it.
- Tool-call request logs are a multi-step run: create run, append generate/tool steps, then finish run. This makes AI SDK multi-step behavior visible in the dashboard instead of logging only one opaque completion.
- Tool results update the existing `tool_call` step by `request_log_id + tool_call_id`. They are not logged as a second unrelated completion row.
- The server infers single-turn completion versus an open tool run from context and finish reason. The removed caller-selected `logMode` contract must not be recreated.
- `runContext.requestLogId` is intentionally direct. qgrid SDK and server are in the same product boundary, so an opaque indirection was not worth the complexity.
- Lifecycle endpoints remain public because `createQgridLogger` records non-qgrid AI SDK calls into qgrid logs without forcing those calls through the qgrid provider.
- Structured-output failures should fail honestly. Especially on Claude Code, partial or invalid structured output must not be rescued into a fake success.
- Streaming with tools re-emits `answer` deltas by incrementally parsing the
  envelope client-side (SDK 2.6.10, SON-527). The server keeps forwarding raw
  envelope deltas unchanged; the SDK parser is preview-only and the strict
  server decoder still owns the final result. Silence-on-anomaly plus the done
  full-text fallback means the worst case degrades to the old hold-everything
  behavior, never to leaked envelope text. See
  `references/tool-calling-and-multiturn.md` (Streaming With Tools).

## OpenAI Direct Codex Runtime

Key decisions:

- OpenAI uses direct HTTPS `POST` to the private ChatGPT Codex Responses backend and decodes SSE. It does not spawn Codex child processes.
- Direct PKCE OAuth, refresh, and `wham/usage` quota lookup replace delegated runtime calls. Generation and quota requests send Codex CLI identity headers.
- Requests run uncapped, matching the Anthropic runtime: transport is a single HTTPS/WS request, so no local resource justifies a cap, and upstream limits are the backend's responses. The worker-era permit/queue layer was removed once this became clear.
- Every turn sends full Responses-format history. A model-scoped opaque value derived from `sessionKey` is forwarded as `prompt_cache_key`; it is not a provider thread address.
- `AbortSignal` cancellation covers queue wait, retry delay, and active HTTPS transport.
- The transport interface is independent of HTTPS so a future WebSocket implementation can preserve dispatcher behavior.
- The backend is private and unstable. Mocked protocol tests do not establish live provider compatibility.
- OpenAI cached tokens are included in `input_tokens`. Cache-hit denominator is `input_tokens`, not `input + cache_read + cache_creation`.

## Anthropic/Claude Code Runtime

Sources:

- `docs/brainstorms/2026-06-16-anthropic-provider-revival-problem-definition.md`
- `docs/plans/2026-06-24-001-refactor-anthropic-cold-only-routing-plan.md`
- `docs/solutions/integration-issues/claude-cli-drops-assistant-role-in-stream-json.md`
- `docs/solutions/tooling-decisions/anthropic-structured-stream-keep-required-and-fail-honestly.md`
- `docs/plans/2026-06-23-001-feat-anthropic-1m-context-plan.md`
- `docs/solutions/security-issues/claude-cli-anthropic-api-key-leak-audit.md`
- `docs/solutions/security-issues/qgrid-cross-user-context-leak-via-claude-settings-sources.md`
- `docs/solutions/integration-issues/claude-code-oauth-tokens-share-prompt-cache.md`

Key decisions:

- Anthropic is an internal Claude subscription OAuth path. The API-key provider was not pursued because it does not serve qgrid's subscription-pooling value.
- Anthropic is cold-only. It does not use OpenAI `sessionKey` affinity because Claude Code prompt cache is prefix-based and AI SDK consumers already send full message history for each step.
- The shared `threadCoord` response shape may still appear for provider symmetry, but AI SDK storage/replay is disabled for `anthropic/*` models.
- Claude Code `stream-json` drops structural assistant role replay in the outbound API payload. qgrid flattens prior history into text because structural role replay through the CLI is not reliable.
- **qgrid does not pass `--json-schema` to Claude Code (SON-532, 2026-08).** CC's mode is not
  constrained decoding — it creates a `StructuredOutput` tool, scores the free-form output with
  AJV afterwards, and retries internally on mismatch with no off switch. The strictified scoring
  schema contradicted consumer intent (nullish frozen into required), so correct-per-instructions
  outputs were rejected and retried invisibly: deti transcripts showed 2–4 round trips, 216–512 s,
  and 4.7–9.1× billed output per call, collapsed into one request-log row. Schemas and the tool
  envelope now travel as text at the end of the system prompt (`schema-prompt.ts`, consumer's
  original schema, no strictify), the server strips fences only (`fence-strip.ts`), and validation
  is consumer zod / `parseEnvelope`. Honest failure on violations is unchanged.
- Legacy (structured path, unreachable from qgrid dispatch): `MAX_STRUCTURED_OUTPUT_RETRIES=1`
  means one attempt (never set 0), and the retry pin was scoped to **streaming** structured calls
  only — SON-495's latency argument does not hold for non-streaming `generate`, where pinning
  produced a 39.6% failure rate for `deti_production` on Opus 4.8 (dev0, 2026-07).
- 1M context support is measured per model and is a mitigation, not a guarantee. It reduces compaction/hang frequency for huge prompts, but does not make every structured prompt reliable.
- Spawn env must be whitelisted. Never pass inherited `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or `ANTHROPIC_BASE_URL` unless intentionally building an API-key/proxy path.
- `--setting-sources project` is required for shared-service isolation. User/local Claude settings can load hooks or memory and leak context across requests.
- Claude Code OAuth prompt cache sharing across tokens in the same workspace is an observed cost behavior, not a product contract. Monitor it; do not promise it.

## Token Sync And Quota Thresholds

Sources:

- `docs/plans/2026-05-02-feat-token-sync-via-pg-listen-notify-plan.md`
- `docs/brainstorms/2026-06-30-token-quota-threshold-requirements.md`
- `docs/plans/2026-06-30-001-feat-token-quota-threshold-plan.md`

Key decisions:

- Token changes propagate with PostgreSQL `LISTEN/NOTIFY` plus periodic reconcile. Reconcile is kept because notifications can be missed during disconnects.
- Trigger setup is boot-time idempotent SQL, not a raw migration file, because the Sonamu migration directory is managed and raw files can conflict.
- Trigger payloads stay small (`op`, `id`). Dispatchers reload token rows instead of trusting a large notification body.
- The token subscriber disables statement/idle timeouts for `LISTEN` and uses reconnect backoff.
- `quota_threshold` is a routing guardrail, not a load balancer. It prevents an individual token from crossing a configured utilization percentage; it does not equalize traffic.
- Threshold values are nullable integers from 1 to 100. `0` is not valid; `100` means exclude only at full utilization.
- Provider criteria differ by primary window: Anthropic uses `five_hour.utilization` plus the
  Fable-only `seven_day_overage_included.utilization` when applicable; OpenAI uses
  `primary.usedPercent`.
- Threshold gates are by token id, not token name. Names are display/logging labels and can change.
- Token window keepalive is opt-in at two levels since 2.8.0 (`ea7feb3`): an instance fires only with env `QGRID_TOKEN_WINDOW_KEEPALIVE_ENABLED=true`, and only for tokens with `keepalive_enabled = true`. The runner gate exists because developer instances sharing the production DB fired duplicate pings under the 2.7.6 default-on switch; the per-token flag lets shared or credit-metered accounts stay out. The cost is that upgrades start with zero targets until both are set.
- Lookup failure is fail-open with logs/metrics. Hard failure happens only when usage was read successfully and the token is over threshold.
- OpenAI applies the gate during token selection. An affinity-preferred token over threshold must fall back to another eligible token when possible.

## Weighted Token Routing

Sources:

- `docs/brainstorms/2026-07-10-weighted-token-routing-requirements.md`
- `docs/plans/2026-07-10-weighted-token-routing-plan.md`

Key decisions:

- `tokens.weight` is a per-token integer from 1 to 100 defaulting to 1. It is a relative routing share for new requests, not an enable/disable switch. Weight 0 is invalid; disabling a token stays on `active`.
- Both providers share one smooth weighted round-robin selector in the provider common layer. The selector knows only token ids, weights, and current scores. Dispatchers own quota, lifecycle, and worker availability, and pass in only the eligible token id set per selection. Do not teach the selector about credentials, workers, or queues.
- The quota threshold gate runs before weighted selection. An over-threshold token receives no weighted assignment regardless of weight, and the schedule is computed from the remaining eligible tokens.
- OpenAI cache affinity prefers its prior token whenever that token remains eligible; otherwise routing uses weighted selection.
- Busyness never excludes a token: with no concurrency cap there is no queue and no drain.
- Candidate collection, selector mutation, and worker acquisition must run without an intervening `await`. A weighted score is consumed only when the dispatcher can commit the assignment synchronously; this is what keeps concurrent Anthropic selections spread correctly.
- Selector scores reset when token topology or configured weights change. Temporary ineligibility from quota or busy workers only excludes the token from that selection's candidate set and does not reset schedule state.
- Weight-change notification is owned by the versioned migration trigger (`tokens_weight_changed_upd`); the boot-time trigger setup SQL intentionally excludes `weight` from its WHEN clause, and a test pins this so exactly one trigger fires per weight-only change.
- The token subscriber serializes notification and reconcile handling through an operation chain because weight propagation made dispatcher updates awaited; out-of-order token events could otherwise apply stale weights.
- Required migrations moved from a soft-fail `onStart` step to a hard-fail `bootstrapServer` order (init → migrate → listen). Dispatchers must never boot against a schema missing `tokens.weight`.
- `updateToken` became a partial field update (`TokenModel.updateFields`) so the dashboard weight control cannot overwrite name or quota threshold edits happening elsewhere.
- Explicit scope boundaries: no per-model, per-project, per-request, or time-varying weights, and no automatic weight adjustment from remaining quota, latency, cost, errors, or worker counts.

## Request Logs, Metrics, And Dashboard

Sources:

- `docs/plans/2026-05-21-feat-qgrid-logger-telemetry-integration-plan.md`
- `docs/brainstorms/2026-07-01-request-log-ttft-metric-requirements.md`
- `docs/solutions/logic-errors/qgrid-prompt-cache-hit-rate-metric-miscalculation.md`
- `docs/solutions/performance-issues/sonamu-findmany-aggregate-slowdown.md`
- `docs/solutions/performance-issues/qgrid-request-logs-subset-and-distinct-query-optimization.md`

Key decisions:

- The dashboard/logging layer is a core qgrid value, not an incidental web UI. It lets operators see cost, cache, TTFT, token routing, tool steps, and project-level workloads.
- `createQgridLogger` exists so teams can keep using native AI SDK providers while still recording those calls in qgrid request logs. It should not throw into user code.
- New log model identities use the existing `requested_model_name` and `model_name` fields in `provider/model` form, including external-provider telemetry logs. There is no separate provider column and no backfill of legacy prefixless rows.
- A running parent has no confirmed serving model. Store its requested route separately, leave `model_name` null, and make dashboard running-state rendering depend on `status` rather than placeholder model text.
- Request-log TTFT is the first generate-step TTFT. It intentionally measures generation responsiveness, not queue time or full request latency.
- Cache-hit metrics must be derived consistently from normalized provider accounting. Keep metric logic centralized when possible.
- Request-log list queries should avoid large text/blob columns unless the UI needs them. The list view is for scanning, not payload archival.
- Aggregate endpoints can intentionally duplicate filters in raw SQL instead of reusing `findMany`. Materializing full rows for aggregates was measured as too slow.
- Project-name filters matter at scale. Encourage `QGRID_PROJECT_NAME` so dashboards can distinguish workloads without inspecting prompts.
- Setup agents are part of the intended local qgrid workflow. They should ask for or add a project label during setup because retroactively untangling anonymous request logs is expensive once multiple projects or workflows share a qgrid server.

## CLI Packaging And Server Boot

Sources:

- `docs/plans/2026-04-06-feat-package-split-sdk-cli-plan.md`
- `docs/plans/2026-04-13-refactor-cli-bundle-rollback-plan.md`
- `references/cli-env-and-server-boot.md`

Key decisions:

- CLI and SDK were split so AI consumers do not install Sonamu, database, and runtime-server dependencies just to call qgrid.
- The CLI is a direct Node/bundle runner, not a Docker wrapper. Docker was removed to keep `npm i -g ...` plus `qgrid start` usable without local Docker setup.
- CLI user-facing configuration is intentionally small: database connection, port, public callback URL, server URL, and project name. Bundle bootstrapping details are implementation internals.
- The CLI checks runtime CLIs (`codex`, `claude`) because qgrid delegates provider execution to those local binaries.
- The dashboard version should follow the CLI package version because the dashboard is shipped by the CLI bundle, not as an independently versioned web product.
- qgrid skills ship with the CLI package, not a separate skills package. qgrid cannot be used with the AI SDK alone; a local qgrid CLI server is required, so CLI install is the right moment to sync `.agents/skills/qgrid` and `.claude/skills/qgrid` into the consuming project.

## Image Generation

Sources:

- `docs/brainstorms/2026-07-05-qgrid-image-generation-requirements.md`
- `docs/plans/2026-07-05-001-feat-codex-image-generation-plan.md`
- `docs/brainstorms/2026-07-06-qgrid-image-persistence-requirements.md`
- `docs/brainstorms/2026-07-06-codex-image-cost-estimate.md`

Key decisions:

- Image generation is OpenAI/Codex-only and request-level opt-in. It is essentially a Codex-hosted `image_generation` tool call, not qgrid directly calling the OpenAI Images API. Always-on image tools would change every turn's tool configuration and threaten prompt-cache stability.
- It is non-stream only. Codex returns completed base64 image payloads, not useful image deltas.
- Image turns send full input directly and retain no provider conversation state. This prevents base64 payloads from entering reusable state.
- qgrid performs preflight capability/model gates and postflight "image count must be greater than zero" checks. Codex can otherwise silently return text when image generation is unavailable or unused.
- Returned images are inline base64 content parts for consumers and AI SDK `file` parts. Reference images are accepted through AI SDK multimodal message parts only on the `imageGeneration` path, and are transported as JSON data URLs with SDK-side size guarding.
- `imageGenerationOptions` currently supports quality and size. The worker instruction and request-log pricing assumption use `gpt-image-2`, with defaults `medium` and `1536x1024`.
- qgrid does not manage generated or reference images as durable assets through a `generated_images` table or object-storage layer. Current request logs can still contain inline image data URLs for inspection and synthetic `image_generation` tool-call steps; reference input images live in the first synthetic step's `tool_args.inputImages`.
- Image cost is stored separately in `request_logs.image_cost_usd`; `request_logs.cost_usd` remains the Codex driver model token cost. Because Codex does not expose exact image tool usage, `image_cost_usd` is a price-table estimate and may be inaccurate.
- Inspect current plans, tests, and implementation before changing behavior; the Codex tool surface can change underneath qgrid.
