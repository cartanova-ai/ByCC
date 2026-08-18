# Request Log Run Lifecycle

Use this reference when changing request logging, tool-call loop logging, telemetry logger integration, request log steps, or dashboard metrics.

## Logging switch

qgrid query and stream inputs support `logger?: boolean`:

- Omitted or `true`: request logging is enabled. This is the default.
- `false`: the generation creates zero qgrid request-log parent or step rows.

The AI SDK exposes the switch as `providerOptions.qgrid.logger`. `logger: false` changes observability only: generation, streaming, AI SDK tool execution, tool-result continuation, and provider thread coordination remain active. The SDK keeps pending tool-call correlation locally when no request-log id exists.

`logMode` has been removed. The wire schema no longer special-cases it, so a stray `logMode` key is silently ignored like any unknown key — it must not appear in new code. Migrate old callers as follows:

- Omitted mode or `"auto"`: remove it; omit `logger` or use `logger: true`.
- `"run"`: remove it; the server infers tool-run lifecycle.
- `"none"`: replace it with `logger: false`.

## Server-inferred lifecycle

For every logger-enabled initial qgrid query or stream, the server owns the lifecycle:

1. Create one parent request log with `status = running` before provider execution.
2. Execute the provider call.
3. Append the generate step and any pending tool-call steps.
4. If the provider finishes with tool calls, keep the parent running and return its request-log id in `runContext`.
5. If the provider finishes normally, aggregate the steps and finish the same parent row.

A tool-result follow-up carries the returned `runContext` and tool results. The server completes the pending tool steps, appends the next generate step, and again decides from the provider finish reason whether to keep the run open or finish it. Callers do not select a single-request or run mode.

Errors and client aborts finish the same parent as `error` or `aborted` and roll up usage, cost, fallback count, and cost provenance from every generate step that completed before termination. SSE client closure is authoritative regardless of the provider's abort error text; if a provider result arrives after closure, record its step usage and then leave the parent `aborted` without publishing `done`.

Creating the initial `running` row is a precondition for a logger-enabled provider call. Once the provider has succeeded, however, a failure while appending or finalizing logs is best-effort: report the logging error and preserve the generated text/stream result instead of making logging failure replace a successful model result.

Stale cleanup must target old runs that still have unresolved tool-call steps; a long provider request with no pending tool call is not stale merely because its parent row is still running. Cleanup and arriving tool follow-ups share a PostgreSQL transaction advisory lock per request-log id and recheck the unresolved step after acquiring it, so cleanup cannot overwrite an in-flight follow-up across server processes.
Candidate discovery is only a hint; each candidate is rechecked and finalized in its own short Sonamu `@transactional` write operation. Use `getPuri("w")` throughout that operation so the advisory lock, aggregate reads, and terminal update stay on the same transaction connection.

## Tool-call loop

The AI SDK provider tracks pending tool-call IDs. When the next AI SDK call contains all required tool results, it sends the existing logging `runContext` when one was returned and sends the tool results. With `logger: false`, it still correlates the pending calls locally and continues the generation without a request-log id.

qgrid converts tool results into continuation input for providers. Cold fallback still includes a "continue using these results" text input.

Tool calls are produced through qgrid structured-output emulation, not native provider tool calling. The lifecycle records the emulated generate step, pending tool-call step rows, tool results on follow-up, and the final generate step. For full semantics, read `tool-calling-and-multiturn.md`.

## Provider and model storage

New request logs store routed model identity in the existing model fields; they do not add a separate provider column:

- While the parent is running, `requested_model_name` is the full requested id such as `openai/gpt-5.4` and `model_name` is `NULL`.
- Completed parent and generate-step model values use full `provider/model` ids.
- `requested_model_name` preserves the exact requested route, including modifiers such as Anthropic `[1m]`; `model_name` is the actual canonical serving route. They differ after a Fable refusal fallback, for example requested Fable versus serving Opus.
- A completed multi-step parent uses the final turn's requested and serving models. It never stores the literal model value `mixed`; usage and cost still aggregate across steps, and `cost_source` may be `mixed`.
- Public qgrid `QueryOutput.model` and AI SDK response model metadata continue to report the provider runtime model without changing their response contract. Do not copy that prefixless response value directly into server-native storage.
- `createQgridLogger` combines the telemetry model provider and model id for the requested value, and qualifies the observed step/final response model with that provider. AI SDK adapter ids such as `openai.responses` and `anthropic.messages` are normalized to their base provider before storage. Avoid duplicating a prefix when the model id already starts with the same provider.

This is a forward-only storage normalization. Do not backfill legacy prefixless rows, and do not invent a new `provider` column. Dashboard and query consumers must tolerate both legacy prefixless values and new prefixed values. Treat `status` as authoritative: a running row has no confirmed serving model, so the dashboard should render an explicit running state rather than a model placeholder or fallback display.

Provider-qualified ids widen `model_name` and `requested_model_name` from 50 to 255 characters on both request-log entities. Generate and apply the normal Sonamu schema migration before running the new server. Do not hand-edit generated types, hand-author a derivable migration, or rewrite existing model values as part of that width migration.

## Usage fields

Stored request log usage uses qgrid-standard semantics:

- `input_tokens`: total input, including cache read/write.
- `cache_read_tokens`: cached input read.
- `cache_creation_tokens`: prompt cache write input.
- `cache_creation_5m_tokens` / `cache_creation_1h_tokens`: nullable Anthropic TTL breakdown.
- `output_tokens`: output tokens.
- `cost_usd`: integer micro-USD in DB; displayed USD is `cost_usd / 1_000_000`.
- `cost_source`: `provider`, `pricing_table`, or `mixed`. New rows keep the cost calculated at request time.
- `fallback_count`: number of observed model fallbacks in the run/step.
- `image_cost_usd`: integer micro-USD estimate for Codex image generation output.
- `image_cost_method`: string such as `assumed:gpt-image-2:medium:1536x1024:png`.

OpenAI uses the completed Responses event's per-request usage fields.

Anthropic normalizes native mutually exclusive categories by summing input + cache creation + cache read into total input. Prefer positive Claude Code `total_cost_usd`; otherwise calculate from the actual serving model and TTL split.

For image requests, keep `cost_usd` as the Codex driver model token cost. Image output cost is separate because qgrid observes Codex's `image_generation` result, not the OpenAI Images API usage object. Treat `image_cost_usd` as a price-table estimate that may be inaccurate if Codex changes its underlying image accounting.

Reference images for image generation are not stored in `request_logs.user_prompt`; that field remains the text prompt. For inspection in the detail view, qgrid stores reference image metadata/base64 in the synthetic `image_generation` step's `tool_args.inputImages`. If Codex returns multiple image outputs, store `inputImages` only on the first synthetic image tool step so multi-output logs do not duplicate the same input payload on every output.

## Structured output fields

Structured output requests (those carrying a `jsonSchema`) persist three related fields:

- `json_schema`: the raw JSON Schema text of the request contract. Stored at `createRun`, exposed only through the server-side `responseTypeTs` conversion API (compact `type` declaration + reconstructed zod expression); the detail subset does not carry the raw text.
- `is_structured`: boolean written at `createRun` from `json_schema` presence. Exists so the list subset can distinguish structured vs plain rows without shipping schema text; it is denormalized, so any future path that writes `json_schema` must set it too.
- `response_json_ok`: tri-state verdict written at the succeeded `finishRun`. `true`/`false` = structured response parsed/failed `JSON.parse`; `null` = non-structured request, error/aborted run, or a row written before the column existed. The list keeps the `broken` badge for explicit `false` but exposes no dedicated filter.

Reconstructed zod output cannot contain `refine`/`transform` logic — those are lost when the client serializes the schema. Rows written by servers older than 2.7.2 have all three fields empty/false/null.

## Legacy normalization

`RequestLogModel` normalizes legacy Anthropic rows where stored `input_tokens` may not include cache read/write. Rows with `cost_source = NULL` are legacy and can be repriced from the current table; rows with a source retain their exact stored cost across price/promotion changes.

## TTFT

TTFT is tracked by wrapping the first provider delta:

- OpenAI: first `response.output_text.delta` from the direct Responses stream.
- Anthropic: first text or structured partial JSON delta.

If missing, qgrid maps TTFT to `0` in `QueryOutput` and nullable/optional places as appropriate.

## Logger integration

`packages/ai-sdk/src/logger.ts` lets non-qgrid providers write logs into qgrid through the public lifecycle endpoints. It skips model provider `qgrid` to avoid double logging and skips any generation with `providerOptions.qgrid.logger: false`. Therefore one disabled generation produces neither native qgrid logs nor `createQgridLogger` telemetry logs. Preserve its stale-run fallback because AI SDK telemetry may emit start without a final event on provider failures.
