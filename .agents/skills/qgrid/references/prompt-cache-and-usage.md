# Prompt Cache And Usage

Use this reference for `sessionKey`, `threadCoord`, prompt cache, request-log usage metrics, and cost accounting.

## qgrid thread coordinates

Client-facing `QgridThreadCoord`:

```ts
{
  workerId: number;
  threadId: string;
  epoch: number;
  systemHash: string;
}
```

- Server issues this after a provider turn.
- Client returns it through `runContext.threadCoord`.
- AI SDK hides this behind `providerOptions.qgrid.sessionKey` for OpenAI models.
- `systemHash` is the first 16 hex chars of SHA-256 over the system prompt.
- Reuse is eligible only when incoming `systemHash` matches current system prompt.

## AI SDK `sessionKey`

`packages/ai-sdk/src/index.ts` stores `threadCoord` in a module-level map by `sessionKey` for 10 minutes.

- OpenAI models: `sessionKey` can replay the stored coordinate.
- Anthropic models: `reusableSessionKey` returns `undefined`, so the coordinate is not stored or replayed.
- Tool-call loop run context and non-tool multi-turn context share the same `runContext` boundary.

## OpenAI/Codex cache behavior

Codex sets OpenAI prompt-cache affinity from the Codex conversation/thread id. qgrid originally got cache misses by creating a new thread for every request. Thread reuse fixes this by keeping the same Codex thread for a logical conversation.

Cache hit requires:

1. `QGRID_OPENAI_THREAD_REUSE` is not `"false"`.
2. AI SDK sends a stable `sessionKey`.
3. Server receives a `threadCoord`.
4. `systemHash` matches.
5. The target worker exists, is ready/active, has same `epoch`, and still has the thread.
6. The worker becomes free within the reuse wait window.
7. Prefix content remains stable.

When reuse succeeds, qgrid sends only delta input to `turn/start`. When reuse fails, qgrid falls back to cold execution with full prompt plus history injection.

Reuse is decided before weighted token routing and stays pinned to its original worker: a successful reuse neither consumes nor advances the weighted schedule. Cache affinity intentionally beats weight distribution; only cold requests are weighted.

Important cache breakers:

- Different system prompt.
- Worker restart or thread TTL eviction.
- Schema/output format changes near the prefix. Codex places `outputSchema` in a prefix-sensitive area, so changing schemas turn-by-turn can break cache even on the same thread.
- Image generation requests, which intentionally use cold one-shot threads and do not issue reuse coordinates.

## Anthropic/Claude Code cache behavior

Anthropic uses fresh Claude Code process spawn per request. qgrid does not replay Anthropic `sessionKey`.

Prompt cache can still work when prefixes are stable, but:

- Full history is replayed through stream-json after flattening.
- Cache write/read can be eventually consistent; immediate next request is not guaranteed to hit.
- Claude Code OAuth token cache behavior has provider-specific quirks documented in `docs/solutions`.
- Avoid putting volatile schema text into the system prompt. qgrid uses `--json-schema` / `StructuredOutput` for structured output.

## Usage normalization

qgrid's standard usage meaning:

- `input_tokens`: total input for this request, including cache read and cache creation input.
- `cache_read_tokens`: cached input read.
- `cache_creation_tokens`: input written to prompt cache.
- `output_tokens`: output tokens.

OpenAI/Codex already reports `inputTokens` as total input including cached input. Use Codex `tokenUsage.last` for per-request logs, not `tokenUsage.total`.

Anthropic native usage categories are mutually exclusive:

- `input_tokens`
- `cache_creation_input_tokens`
- `cache_read_input_tokens`

qgrid normalizes Anthropic by summing those three into standard `inputTokens` and preserving cache read/write as subfields.

## Cache hit rate

For qgrid-standard usage, hit rate denominator is `input_tokens`, not `input_tokens + cache_read_tokens + cache_creation_tokens`.

Do not double-count cache subfields. This was a real dashboard bug: OpenAI cache hit rates could be displayed near half their actual value when cache tokens were added to the denominator again.

## Cost accounting

`packages/api/src/utils/providers/common/model-cost.ts` contains model price fallback.

- OpenAI cost normally uses qgrid's price table.
- OpenAI image generation stores a separate `image_cost_usd` estimate. It assumes Codex's image tool is priced as `gpt-image-2` for the selected/default quality and size, because qgrid does not receive exact image tool usage from Codex.
- Anthropic Claude Code may return `total_cost_usd`; qgrid prefers provider cost when present and positive.
- Anthropic responses can split cache creation into `ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens`; preserve that split and price each TTL separately.
- Claude Code automatically requests 1-hour cache TTL for subscription OAuth and 5-minute TTL for API-key or usage-credit paths. Only legacy responses without a TTL breakdown use the subscription path's 1-hour rate as qgrid's fallback.
- Persist per-step `cost_usd`, `cost_source`, and the 5m/1h split. New request logs use that exact stored cost; only legacy rows with no `cost_source` are repriced from the current table.
- When Fable refuses and Claude Code serves Opus, prefer Claude Code's positive `total_cost_usd`. Persist Fable as the requested model and Opus as the serving model instead of pricing the combined turn as Fable.
- OpenAI long-context surcharge applies to the whole request when input exceeds the model threshold, not just the excess tokens.

When changing models or prices, verify against current official pricing before editing the table.
