# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Agent setup and request logging

### qgrid skill sync
The install-time process that makes qgrid's agent instructions discoverable to local coding agents by placing the same qgrid skill in both Codex and Claude Code skill search locations.

### Request-log project label
A caller-provided workload identity attached to qgrid request logs so operators can group traffic, metrics, and debugging context by project or workflow instead of inferring ownership from prompts or tokens.

### Monit tab
The dashboard's ephemeral process-log surface: a terminal-style scrollback-plus-live-tail view over the server's in-memory log buffer, which resets on restart. Distinct from Request Logs, the persistent per-request DB record — Monit shows what the server terminal shows, so a remote instance can be observed without SSH.

## Prompt cache & thread reuse

### Thread reuse
Routing successive turns of one logical conversation onto the same codex thread so the OpenAI prompt cache stays warm. Because codex binds the prompt cache key to the thread's conversation identity (see Prompt cache key), a fresh thread per request gets a brand-new key and never hits cache; reuse keeps the key stable so the unchanged prefix is served from cache.

### Prompt cache key
codex's cache-affinity key for OpenAI prompt caching, which codex sets equal to a thread's conversation identity and does not let callers override. Its practical consequence: cache affinity follows thread identity, not prompt content — two byte-identical prompts on different threads still miss, and the same thread across turns hits.

### sessionKey
The caller-supplied string qgrid uses as a logical request-affinity hint. On the OpenAI/codex path it can map to a reusable thread coordinate so thread reuse keeps the prompt cache key stable; on the Anthropic path qgrid may accept the same hint without using it for reuse, because that route is cold-only for current consumers.

Distinct call kinds (different output schemas) must use distinct sessionKeys when the route can reuse a thread: the output schema sits in the cacheable prefix, so mixing schemas on one thread breaks the cache for all of them. Callers should not branch on provider-specific reuse rules; they pass qgrid provider options, and qgrid decides how each model route applies them.

### Conversation fingerprint
The server-computed identity of a conversation prefix: a hash over the system prompt, the output schema, the caller's declared project name (a best-effort caller boundary, not an authentication boundary), the model, the verbosity setting, and the canonically normalized declared history. Two requests belong to the same logical conversation exactly when their fingerprints match — identity is defined by full declared-history equality, never guessed from partial signals. A registered fingerprint is always the *next-turn* expectation and therefore includes the previous assistant response, so an empty-history request, a retry, or a reroll can never collide with a live conversation's key. Normalization is fail-closed: history content the normalizer does not recognize yields no fingerprint at all rather than a lossy one.

### Thread registry
The server-side map from a conversation's next-turn fingerprint to the thread coordinate holding its accumulated state, enabling thread reuse without any client-side coordinate round-trip. Entries are checked out on match (a synchronous get-and-delete, so one of two concurrent identical requests wins and the other goes cold) and re-registered only when a turn completes successfully; a failed turn discards the entry because its thread may hold a partially applied turn. A thread has at most one live entry (enforced via a threadId reverse index), and starting a turn on a thread through any path — explicit coordinate, synthesized coordinate, or tool follow-up — invalidates that thread's existing entry, so an entry can never describe a thread that has since advanced. Misses and discarded entries fall back to a cold thread with full history injection, so the miss direction is always safe; the hit direction's correctness rests on the fingerprint-equality invariant plus this invalidation rule.

## Token pool capability

### 1M context entitlement
Whether a pooled token's backing account is permitted to run a given model's 1M-token context window. It is not uniform across the pool: the same model can be allowed on one token and refused on another, because the entitlement is evaluated per account at request time. For some models the 1M window is included in the subscription; for others it is gated behind separately-enabled usage credits, so an active token is not by itself proof that a 1M request will succeed. A token-selection policy that treats all tokens as interchangeable for 1M requests fails intermittently whenever it routes to a token whose account lacks the entitlement.

### Auth-dead token
A pooled token whose provider refresh has failed with a determinate permanent code (OpenAI `refresh_token_expired`/`refresh_token_reused`/`refresh_token_invalidated`, Anthropic refresh 400/401), meaning re-login is the only recovery. qgrid treats this determination as the single anchor event: the token flips to inactive (removed from routing pool-wide via token sync), and the flip — which happens at most once per death — is what drives the Slack death notification. Transient failures (network, 5xx) and one-off in-turn 401s are not auth-death signals. Deliberately not distinguished from manual deactivation in the schema or dashboard; the reason lives only in the notification.

### Token recovery
Re-login with the same provider account (matched by account identifier), which replaces the dead token row with a fresh active one under the existing dedup rule. This is the event that fires the Slack recovery notification; manually toggling a token back to active is not a recovery — the session may still be expired.

### Workspace-scoped prompt cache
On the Anthropic path, the boundary within which a prompt cache is shared: tokens whose backing accounts belong to the same Anthropic workspace read each other's cache, and tokens outside it never do — even for a byte-identical prefix. The sharing boundary is the workspace, not the individual account and not the product as a whole, so two different accounts in one workspace share a cache box while the same account split across workspaces would not. This makes cross-token cache reuse a property of how the pool is composed: a pool drawn from one workspace keeps the cache warm as it round-robins across tokens; mixing in a token from another workspace silently triggers cache re-creation whenever a request routes to it.

## Structured output

### Structured output enforcement
How a provider makes a model conform to a requested JSON schema, and how strong that guarantee is. The two routes qgrid uses differ in kind, not degree. The OpenAI/codex route uses constrained decoding: the schema constrains token generation itself, so a conforming object is the only thing the model can emit — field omission, placeholder, or refusal cannot escape; qgrid therefore hands OpenAI a strictified schema (all fields required, `additionalProperties: false`). The Anthropic/Claude Code route has no constrained decoding to offer, and CC's own `--json-schema` mode is guide-then-validate: the model writes freely and CC scores the output with AJV afterwards, retrying internally on mismatch. qgrid stopped using that mode (SON-532) after the scorer proved to be the problem — the strictified schema it scored against contradicted consumer intent (nullish fields frozen into required), igniting silent retry loops that multiplied latency and billed tokens without ever appearing in the request log.

On the Anthropic route qgrid instead renders the schema — the consumer's original, unstrictified — as text appended to the system prompt, along with the tool-envelope contract when tools are present. CC generates plain text; qgrid strips code fences and surrounding whitespace and nothing else; validation belongs to the consumer's zod (user schema) and to qgrid's `parseEnvelope` (envelope). Guidance still matters the same way it always did: a field the consumer declared required is presented as required and reliably filled, while an omission the consumer permitted now passes validation instead of tripping a scorer. Non-conforming output (prose preambles, degenerate placeholders) is an honest failure surfaced to the caller — never rescued, and the retry decision belongs to the consumer who can see it.

## Image generation

### Image turn
A turn whose request carries the image-generation opt-in flag, enabling codex's built-in image tool for that turn only. Image turns are validated twice — capability before the turn, at-least-one-completed-image after — because codex silently returns text-only when its gates are unmet, and a silent fallback would masquerade as success. Image turns never participate in thread reuse: their payloads would otherwise sit in thread memory and the cacheable prefix. A request without the flag is unchanged in tool surface and cache behavior.

### Image tool model
The model in a qgrid image request is the Codex/Responses driver model, for example `openai/gpt-5.5`. qgrid does not call the Images API directly; it exposes Codex's hosted `image_generation` Responses tool, whose current local contract only lets qgrid observe/control `output_format: "png"`. Codex returns the generated image payload but not the image tool's usage tokens or exact underlying image model. For quota/cost attribution, qgrid records a separate pricing assumption (`gpt-image-2`, caller/default `quality`, caller/default `size`, `png`) in synthetic tool args and stores the image output estimate in `request_logs.image_cost_usd`; `request_logs.cost_usd` remains the driver model token cost.

## Token accounting

### Per-turn vs cumulative usage
The distinction between a single turn's token usage and a thread's running total across all its turns. A per-request log must record the per-turn figure; recording the cumulative total folds earlier turns (including a cold first turn) into every later request and dilutes per-request metrics like cache hit rate.

### Cache hit rate
The share of a request's input tokens served from prompt cache, computed as cache-read tokens divided by total input tokens. The provider's token convention is load-bearing: in the OpenAI/codex path total input tokens already include the cached portion (cache-read is a subset), so the denominator is input tokens alone; the Anthropic path reports cached and non-cached portions separately, so its accounting differs.
