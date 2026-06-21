# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Prompt cache & thread reuse

### Thread reuse
Routing successive turns of one logical conversation onto the same codex thread so the OpenAI prompt cache stays warm. Because codex binds the prompt cache key to the thread's conversation identity (see Prompt cache key), a fresh thread per request gets a brand-new key and never hits cache; reuse keeps the key stable so the unchanged prefix is served from cache.

### Prompt cache key
codex's cache-affinity key for OpenAI prompt caching, which codex sets equal to a thread's conversation identity and does not let callers override. Its practical consequence: cache affinity follows thread identity, not prompt content — two byte-identical prompts on different threads still miss, and the same thread across turns hits.

### sessionKey
The caller-supplied string qgrid uses to decide which prior thread a request belongs to, so thread reuse can route the request onto that thread. Distinct call kinds (different output schemas) must use distinct sessionKeys: the output schema sits in the cacheable prefix, so mixing schemas on one thread breaks the cache for all of them.

## Token accounting

### Per-turn vs cumulative usage
The distinction between a single turn's token usage and a thread's running total across all its turns. A per-request log must record the per-turn figure; recording the cumulative total folds earlier turns (including a cold first turn) into every later request and dilutes per-request metrics like cache hit rate.

### Cache hit rate
The share of a request's input tokens served from prompt cache, computed as cache-read tokens divided by total input tokens. The provider's token convention is load-bearing: in the OpenAI/codex path total input tokens already include the cached portion (cache-read is a subset), so the denominator is input tokens alone; the Anthropic path reports cached and non-cached portions separately, so its accounting differs.
