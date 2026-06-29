# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Prompt cache & thread reuse

### Thread reuse
Routing successive turns of one logical conversation onto the same codex thread so the OpenAI prompt cache stays warm. Because codex binds the prompt cache key to the thread's conversation identity (see Prompt cache key), a fresh thread per request gets a brand-new key and never hits cache; reuse keeps the key stable so the unchanged prefix is served from cache.

### Prompt cache key
codex's cache-affinity key for OpenAI prompt caching, which codex sets equal to a thread's conversation identity and does not let callers override. Its practical consequence: cache affinity follows thread identity, not prompt content — two byte-identical prompts on different threads still miss, and the same thread across turns hits.

### sessionKey
The caller-supplied string qgrid uses as a logical request-affinity hint. On the OpenAI/codex path it can map to a reusable thread coordinate so thread reuse keeps the prompt cache key stable; on the Anthropic path qgrid may accept the same hint without using it for reuse, because that route is cold-only for current consumers.

Distinct call kinds (different output schemas) must use distinct sessionKeys when the route can reuse a thread: the output schema sits in the cacheable prefix, so mixing schemas on one thread breaks the cache for all of them. Callers should not branch on provider-specific reuse rules; they pass qgrid provider options, and qgrid decides how each model route applies them.

## Token pool capability

### 1M context entitlement
Whether a pooled token's backing account is permitted to run a given model's 1M-token context window. It is not uniform across the pool: the same model can be allowed on one token and refused on another, because the entitlement is evaluated per account at request time. For some models the 1M window is included in the subscription; for others it is gated behind separately-enabled usage credits, so an active token is not by itself proof that a 1M request will succeed. A token-selection policy that treats all tokens as interchangeable for 1M requests fails intermittently whenever it routes to a token whose account lacks the entitlement.

### Workspace-scoped prompt cache
On the Anthropic path, the boundary within which a prompt cache is shared: tokens whose backing accounts belong to the same Anthropic workspace read each other's cache, and tokens outside it never do — even for a byte-identical prefix. The sharing boundary is the workspace, not the individual account and not the product as a whole, so two different accounts in one workspace share a cache box while the same account split across workspaces would not. This makes cross-token cache reuse a property of how the pool is composed: a pool drawn from one workspace keeps the cache warm as it round-robins across tokens; mixing in a token from another workspace silently triggers cache re-creation whenever a request routes to it.

## Structured output

### Structured output enforcement
How a provider makes a model conform to a requested JSON schema, and how strong that guarantee is. The two routes qgrid uses differ in kind, not degree. The OpenAI/codex route uses constrained decoding: the schema constrains token generation itself, so a conforming object is the only thing the model can emit — field omission, placeholder, or refusal cannot escape. The Anthropic/Claude Code route is not constrained decoding: the schema becomes a synthetic output tool whose input the model writes freely, validated against the schema only after generation; the model can therefore produce a non-conforming attempt that is caught (and retried, or failed) after the fact. The practical consequence is that the Anthropic route is inherently less reliable for structured output than the OpenAI route, and that gap lives in the provider, not in qgrid.

Because Anthropic enforcement is a guide-then-validate, the schema's `required` set is load-bearing: a field kept required is reliably filled, while a field made optional is frequently omitted key-and-all — so loosening a schema to "accept" omissions instead induces them. Outputs that exhaust the schema-retry budget or otherwise terminate non-successfully (including degenerate placeholder or refusal text) are treated as honest failures, not rescued, because partial or speculative structured output cannot be safely promoted to success.

## Token accounting

### Per-turn vs cumulative usage
The distinction between a single turn's token usage and a thread's running total across all its turns. A per-request log must record the per-turn figure; recording the cumulative total folds earlier turns (including a cold first turn) into every later request and dilutes per-request metrics like cache hit rate.

### Cache hit rate
The share of a request's input tokens served from prompt cache, computed as cache-read tokens divided by total input tokens. The provider's token convention is load-bearing: in the OpenAI/codex path total input tokens already include the cached portion (cache-read is a subset), so the denominator is input tokens alone; the Anthropic path reports cached and non-cached portions separately, so its accounting differs.
