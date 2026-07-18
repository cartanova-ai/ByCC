# Decision Rationale

Use this reference when the question is "why is qgrid designed this way?" or before changing an established runtime contract. Current code is the source of truth for behavior; repo docs are the source of truth for the decision trail.

Do not copy these notes blindly into implementation. Use them to find the relevant docs, then inspect the current code and tests.

## Contents

- AI SDK provider boundary
- Tool calling and request-log lifecycle
- OpenAI/Codex runtime
- Anthropic/Claude Code runtime
- Token sync and quota thresholds
- Request logs, metrics, and dashboard
- CLI packaging and server boot
- Image generation

## AI SDK Provider Boundary

Sources:

- `docs/plans/2026-05-07-feat-qgrid-ai-sdk-provider-plan.md`
- `docs/solutions/conventions/qgrid-provider-options-boundary.md`
- `docs/plans/2026-05-26-refactor-ai-sdk-wrapper-correlation-boundary-plan.md`

Key decisions:

- `packages/ai-sdk` is the active public SDK. `packages/sdk` is deprecated and should be read only for legacy context.
- qgrid's AI SDK provider follows the AI SDK `LanguageModelV3` contract. Generic usage belongs to AI SDK docs; qgrid-specific docs should focus on qgrid routing, logging, cache/session behavior, and `providerOptions.qgrid`.
- qgrid-specific options live under `providerOptions.qgrid`, not under provider-specific namespaces such as `providerOptions.openai`. Consumers should not need to branch on Codex versus Claude internals.
- AI SDK exposes the outer `providerOptions` as a generic JSON record. `QgridProviderOptions` intentionally types the nested `providerOptions.qgrid` value, and examples should apply `satisfies` there to restore qgrid-specific inference without replacing AI SDK's outer contract.
- `projectName` is provider config/payload camelCase. `project_name` is the Sonamu/database request-log column. Prefer `QGRID_PROJECT_NAME` as the project-wide default so request logs and metrics remain filterable at volume.
- `fallbackModels` may exist as a typed future option, but it is not a server wire contract until the server implements fallback routing. Do not forward it as behavior just because the type exists.
- Fable 5 refusal fallback is an upstream Claude Code safety path to Opus 4.8, not qgrid's reserved `fallbackModels` feature or Claude Code's overload-only `--fallback-model` flag. qgrid observes and reports the actual route and provider cost; it must not retry again.
- The SDK should stay a thin adapter. Server APIs own request-log lifecycle, provider dispatch, structured-output emulation, and provider runtime details.

## Tool Calling And Request-Log Lifecycle

Sources:

- `docs/plans/2026-05-07-feat-qgrid-ai-sdk-provider-plan.md`
- `docs/plans/2026-05-20-feat-request-log-run-lifecycle-api-plan.md`
- `docs/plans/2026-05-26-refactor-ai-sdk-wrapper-correlation-boundary-plan.md`
- `docs/solutions/tooling-decisions/anthropic-structured-stream-keep-required-and-fail-honestly.md`

Key decisions:

- qgrid tool calling is intentionally implemented through structured-output emulation, not native provider tool use. The provider call returns a structured action with tool calls; the AI SDK loop executes tools and sends follow-up turns.
- Tools and `jsonSchema` are mutually exclusive at the qgrid dispatcher boundary because both need the provider structured-output slot.
- Tool-call request logs are a multi-step run: create run, append generate/tool steps, then finish run. This makes AI SDK multi-step behavior visible in the dashboard instead of logging only one opaque completion.
- Tool results update the existing `tool_call` step by `request_log_id + tool_call_id`. They are not logged as a second unrelated completion row.
- `runContext.requestLogId` is intentionally direct. qgrid SDK and server are in the same product boundary, so an opaque indirection was not worth the complexity.
- Lifecycle endpoints remain public because `createQgridLogger` records non-qgrid AI SDK calls into qgrid logs without forcing those calls through the qgrid provider.
- Structured-output failures should fail honestly. Especially on Claude Code, partial or invalid structured output must not be rescued into a fake success.

## OpenAI/Codex Runtime

Sources:

- `docs/plans/2026-05-18-feat-codex-app-server-backend-pivot-plan.md`
- `docs/plans/2026-05-30-feat-codex-builtin-tool-suppression-plan.md`
- `docs/plans/2026-06-06-feat-codex-thread-reuse-prompt-cache-plan.md`
- `docs/solutions/logic-errors/qgrid-prompt-cache-hit-rate-metric-miscalculation.md`

Key decisions:

- OpenAI uses Codex `app-server` directly over stdio, not `codex exec`. The app-server path gives qgrid OAuth login, persistent workers, and thread handles.
- Workers are persistent and token-scoped. qgrid can spawn multiple workers per token, but each worker is single-flight for turns. This differs from Anthropic, which fresh-spawns per request.
- qgrid unsets normal OpenAI API-key paths and logs in with ChatGPT/OAuth credentials. This keeps the runtime aligned with subscription-token pooling rather than API billing.
- Built-in Codex tools, apps, skills, web search, shell, and large instruction blocks are suppressed. The primary reason is tool-call correctness: Codex built-ins can steal calls that qgrid expects to represent as emulated AI SDK tool calls. Token savings are secondary.
- Thread reuse exists because Codex/OpenAI prompt cache keys are tied to the Codex conversation/thread. New `thread/start` calls miss cache even with identical prefixes.
- Reuse must be explicit through a server-issued coordinate such as `threadCoord`. Do not use content hashes or hidden closures; same-looking prompts from different sessions can cross-contaminate.
- Reuse fallback should be cold and correct. Invalid worker id, epoch mismatch, missing thread, busy worker timeout, or over-threshold token should not corrupt a conversation.
- Cache and usage metrics use per-turn usage. For Codex, `tokenUsage.total` is conversation cumulative; request logs must use `tokenUsage.last`.
- OpenAI/Codex cached tokens are included in `input_tokens`. Cache-hit denominator is `input_tokens`, not `input + cache_read + cache_creation`.

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
- Anthropic is cold-only. It does not use Codex-style thread reuse because Claude Code prompt cache is prefix-based and AI SDK consumers already send full message history for each step.
- The shared `threadCoord` response shape may still appear for provider symmetry, but AI SDK storage/replay is disabled for `anthropic/*` models.
- Claude Code `stream-json` drops structural assistant role replay in the outbound API payload. qgrid flattens prior history into text because structural role replay through the CLI is not reliable.
- Claude Code `--json-schema` is not constrained native tool calling. It creates a `StructuredOutput` tool and validates after model generation. Keep schemas strict and fail on non-success subtypes or retry exhaustion.
- `MAX_STRUCTURED_OUTPUT_RETRIES=1` means one attempt. Do not set it to 0 expecting "no retry but one attempt"; that can mean no useful attempt.
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
- Provider criteria differ by primary window: Anthropic uses `five_hour.utilization`; OpenAI uses `primary.usedPercent`.
- Threshold gates are by token id, not token name. Names are display/logging labels and can change.
- Lookup failure is fail-open with logs/metrics. Hard failure happens only when usage was read successfully and the token is over threshold.
- OpenAI needs the gate in reuse, idle selection, and queue drain paths. A reusable but over-threshold worker must fall back cold to another eligible token when possible.

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
- Image turns are cold one-shot threads and are excluded from thread reuse. This prevents base64 payloads from entering reusable conversation state and cache prefixes.
- qgrid performs preflight capability/model gates and postflight "image count must be greater than zero" checks. Codex can otherwise silently return text when image generation is unavailable or unused.
- Returned images are inline base64 content parts for consumers and AI SDK `file` parts. Reference images are accepted through AI SDK multimodal message parts only on the `imageGeneration` path, and are transported as JSON data URLs with SDK-side size guarding.
- `imageGenerationOptions` currently supports quality and size. The worker instruction and request-log pricing assumption use `gpt-image-2`, with defaults `medium` and `1536x1024`.
- qgrid does not manage generated or reference images as durable assets through a `generated_images` table or object-storage layer. Current request logs can still contain inline image data URLs for inspection and synthetic `image_generation` tool-call steps; reference input images live in the first synthetic step's `tool_args.inputImages`.
- Image cost is stored separately in `request_logs.image_cost_usd`; `request_logs.cost_usd` remains the Codex driver model token cost. Because Codex does not expose exact image tool usage, `image_cost_usd` is a price-table estimate and may be inaccurate.
- Inspect current plans, tests, and implementation before changing behavior; the Codex tool surface can change underneath qgrid.
