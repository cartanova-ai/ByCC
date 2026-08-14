# Prompt Cache And Usage

Use this reference for `sessionKey`, opaque cache affinity, request-log usage metrics, and cost accounting.

## OpenAI affinity coordinates

The public compatibility shape remains `QgridThreadCoord`:

```ts
{
  workerId: number;
  threadId: string;
  epoch: number;
  systemHash: string;
}
```

These names are legacy. On the direct OpenAI route, the coordinate does not identify a worker process or provider thread. The AI SDK derives a model-scoped opaque SHA-256 value from `sessionKey`, stores the compatibility coordinate briefly, and returns it through `runContext`. The server validates the opaque value and forwards it as `prompt_cache_key`.

Anthropic models do not store or replay this coordinate.

## Full-history replay and cache behavior

OpenAI receives the complete Responses-format conversation history on every request. There is no delta-only turn, process pinning, thread retention, or provider-thread expiry.

A cache hit can occur when both the opaque affinity key and serialized prefix stay stable. Important cache breakers include:

- a different model or system prompt;
- changed tool or output-schema framing;
- changed message order or normalization;
- provider-side cache expiry or policy changes;
- private-backend protocol changes.

Affinity is a hint, not a cache-hit guarantee. The direct endpoint is a private ChatGPT backend and can change without notice. Mocked tests verify qgrid's key derivation and request mapping, not live provider cache behavior.

New requests use smooth weighted routing across quota-eligible tokens with available permits. A compatible coordinate may prefer its prior token, but lack of that permit falls back to eligible routing while preserving the same opaque affinity key and full history.

## Anthropic cache behavior

Anthropic uses a fresh Claude Code process per request. Qgrid does not replay Anthropic `sessionKey`.

Prompt cache can still work when prefixes are stable, but:

- full history is replayed through stream-json after flattening;
- cache write/read can be eventually consistent;
- Claude Code OAuth token cache behavior has provider-specific quirks documented in `docs/solutions`;
- schema/tool-envelope text is appended to the system prompt, so changing it changes the cacheable prefix.

## Usage normalization

Qgrid's standard usage meaning:

- `input_tokens`: total input for this request, including cache read and cache creation input;
- `cache_read_tokens`: cached input read;
- `cache_creation_tokens`: input written to prompt cache;
- `output_tokens`: output tokens.

OpenAI Responses usage already reports input as total input including cached input. Anthropic's native input, cache creation, and cache read categories are mutually exclusive, so qgrid sums them into standard total input while preserving cache subfields.

Cache-hit rate uses `input_tokens` as its denominator. Do not add cache subfields again.

## Cost accounting

`packages/api/src/utils/providers/common/model-cost.ts` contains model-price fallback.

- OpenAI cost normally uses qgrid's price table.
- OpenAI image generation stores a separate `image_cost_usd` estimate because the direct private route does not expose exact image-tool billing.
- Anthropic prefers a positive Claude Code `total_cost_usd`; otherwise qgrid uses its price table.
- Preserve Anthropic's five-minute and one-hour cache-creation token split and price each TTL separately.
- Persist per-step cost, source, and cache-write split. Only legacy rows without a source are repriced.
- OpenAI long-context surcharge applies to the whole request when input exceeds the configured threshold.

When changing models or prices, verify against current official pricing before editing the table. Do not attribute the configured OpenAI context or cost behavior to the removed app-server runtime.
