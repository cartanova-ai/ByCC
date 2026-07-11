# Weighted token routing requirements

Created: 2026-07-10
Status: approved design

## Goal

qgrid must distribute new requests across eligible subscription tokens according to a per-token weight while preserving the existing five-hour quota gate. Weight applies to both OpenAI and Anthropic tokens. OpenAI thread reuse remains pinned to its existing worker and does not participate in weighted selection.

## Current behavior

- `tokens.quota_threshold` is a per-token routing gate. OpenAI reads the primary Codex rate-limit window and Anthropic reads `five_hour.utilization`.
- Tokens at or above their threshold are excluded. Usage lookup failures remain fail-open.
- OpenAI selects from all ready, active, idle workers with a worker-level round-robin cursor. Each token normally has the same configured worker count.
- Anthropic fresh-spawns Claude Code for every request and selects the token with the lowest accumulated request count, using a round-robin index to break ties.
- Token changes propagate through PostgreSQL `LISTEN/NOTIFY` and a periodic reconcile.

## Product contract

### Requirements

- R1: Every token has an integer `weight` from 1 through 100.
- R2: New and existing tokens default to weight 1.
- R3: Weighted routing applies to OpenAI cold requests and all Anthropic requests.
- R4: OpenAI thread reuse stays on its original worker when the worker and quota gate remain eligible. A successful reuse does not read or mutate weighted-routing state.
- R5: The quota threshold gate runs before weighted selection. An over-threshold token receives no new weighted assignment.
- R6: OpenAI routing is work-conserving. A token whose workers are all busy is omitted from the current selection so another eligible idle token can receive the request.
- R7: If every quota-eligible OpenAI worker is busy, the request uses the existing queue. Queue drain performs weighted selection again instead of assigning the worker that happened to finish first.
- R8: Weight changes propagate to running dispatchers through the existing token-change notification and reconcile paths.
- R9: Invalid weight input is rejected at the API and schema boundaries.
- R10: Weight 0 does not disable a token. Token activation remains controlled by `active`.

### User and system flows

- F1: An operator sets a token weight in the qgrid dashboard. The API validates and saves it. The token subscriber updates the provider dispatcher, and subsequent eligible requests use the new distribution.
- F2: A new OpenAI request without reusable thread state passes the quota gate, selects a token using weighted round-robin, and acquires one idle worker from that token.
- F3: An OpenAI request with valid reusable thread state uses the pinned worker without changing weighted-routing state. If its token exceeds quota, the request falls back to the cold path and selects another eligible token.
- F4: An Anthropic request passes the quota gate, selects a token using weighted round-robin, commits the selection before any asynchronous Claude execution, and then fresh-spawns the request.
- F5: When a token is added, removed, activated, deactivated, or assigned a new weight, the affected provider resets its weighted selector state and begins a new schedule from the current token configuration.

### Acceptance examples

- AE1: With continuously eligible tokens weighted 3 and 1, every complete four-request cycle assigns three requests to the first token and one to the second.
- AE2: With weights 5, 2, and 1, a complete eight-request cycle assigns requests in that ratio without expanding an in-memory ring by weight.
- AE3: With all weights set to 1, new requests use token-level round-robin behavior.
- AE4: If a high-weight OpenAI token has no idle workers, an idle lower-weight token receives the request immediately.
- AE5: A successful OpenAI thread-reuse request does not advance or consume the cold-request weighted schedule.
- AE6: If one token exceeds its quota threshold, the selector computes the schedule from the remaining eligible tokens.
- AE7: If all ready tokens exceed quota, the existing `QuotaThresholdExceededError` is returned.
- AE8: A weight update from 1 to 4 takes effect on requests selected after the dispatcher processes the token update.
- AE9: Values below 1, above 100, fractional values, and non-numeric values are rejected.

## Design

### Data model and API

Add `tokens.weight` as a non-null integer with database default 1. The migration source updates existing rows through the column default. Its down path drops the column.

The Token entity subset, generated server and web types, save schema, and token subscriber payload mapping include `weight`. `TokenModel` applies a create default of 1 as an application-level safeguard in addition to the database default.

`QgridFrame.updateToken` accepts an optional `weight`. Omitting it preserves the stored value. Values outside 1 through 100 fail validation with a bad-request response. Token registration does not require callers to send a weight.

The boot-time token trigger watches `weight` in addition to the existing fields. `TokenSubscriber` passes weight through add, update, and reconcile calls for both provider dispatchers.

### Shared selector

Create a provider-independent smooth weighted round-robin selector in the provider common layer. It stores integer current scores keyed by token ID and exposes operations to synchronize token weights, reset state, remove a token, and select from a supplied set of eligible token IDs.

For each selection, the selector:

1. Adds each eligible token's configured weight to its current score.
2. Chooses the highest score, using ascending token ID for deterministic ties.
3. Subtracts the sum of eligible weights from the chosen token's score.
4. Returns the chosen token ID.

The selector does not know about credentials, quota APIs, workers, queues, or provider runtimes. Dispatchers own those policies and pass only the eligible token IDs. Candidate collection, selector mutation, and final token acquisition must run without an intervening `await`; a weighted score is consumed only when the dispatcher can commit the assignment.

Provider topology or weight changes reset the provider's selector state. Temporary ineligibility caused by quota or worker occupancy does not remove token configuration; it only excludes that token from the candidate set for that selection.

### OpenAI routing

The OpenAI dispatcher stores weight with its existing per-token metadata. Cold selection groups ready, active workers by token after quota filtering and keeps only groups containing an idle worker. The shared selector chooses the token, and the dispatcher acquires one idle worker from that group.

The existing reuse path remains ahead of cold selection. It checks active, ready, epoch, thread, busy wait, and quota conditions as it does now. A successful reuse bypasses the selector. A quota-ineligible reuse token is added to the request's exclusion set before cold fallback.

Queue drain must not assign a released worker directly. It calls the same cold acquisition path for the head queue item so all currently idle token groups participate in weighted selection. Existing drain serialization, queue timeout, capacity, abort cleanup, and quota recheck behavior remain in place.

### Anthropic routing

The Anthropic pooled-token metadata includes weight. After the existing quota filter, the dispatcher passes eligible token IDs to the shared selector. Selection and score mutation occur synchronously before refresh or Claude execution begins, so concurrent calls observe committed prior selections.

The existing `requestCounts` map and `rrIndex` are removed. Token refresh, model normalization, streaming, timeout, and fresh-spawn behavior remain unchanged.

### Dashboard

The token usage card displays the current weight and provides a compact control next to the quota-threshold control. The input supports integer values from 1 through 100 and sends the token's existing name and quota threshold when required by the generated mutation contract. Client-side validation improves feedback, but server validation remains authoritative.

The dashboard does not use weight 0 as a disabled state. Operators continue to use the existing Active toggle.

## Failure behavior

- Empty provider pools keep their existing no-token or no-worker errors.
- An OpenAI pool with quota-eligible but busy workers keeps requests queued instead of reporting a quota error.
- An all-over-threshold pool keeps the existing typed quota error and log fields.
- Quota lookup failures keep the existing fail-open logs and eligibility behavior.
- Invalid weight updates fail before persistence and do not alter dispatcher state.
- Runtime weight updates affect later selections and do not move or interrupt in-flight work.

## Database safety

The implementation may add a migration source file and may test it against an isolated local PostgreSQL container. It must not connect to, modify, or migrate dev0 or any other remote database. Static checks and unit tests should be preferred when they provide sufficient coverage.

## Verification

- Unit-test the selector with equal and unequal weights, deterministic ties, temporarily excluded candidates, resets, additions, removals, and empty candidates.
- Extend Anthropic dispatcher tests for weighted sequences, quota-filtered ratios, concurrent selection, and runtime weight updates.
- Extend OpenAI dispatcher tests for token-level weighting across multiple workers, busy-token bypass, queue-drain selection, quota filtering, and reuse bypass.
- Extend token model, frame, subscriber, and trigger tests for defaulting, range validation, preservation, and propagation.
- Regenerate and inspect Sonamu server and web artifacts.
- Run focused API tests and `pnpm check`.
- If migration execution is needed for confidence, use only a disposable local container and verify both up and down paths.

## Scope boundaries

- No per-model, per-project, per-request, or time-varying weights.
- No automatic weight adjustment based on remaining quota, latency, cost, errors, or worker count.
- No weighted treatment of OpenAI thread reuse.
- No changes to quota lookup intervals, threshold semantics, worker count configuration, queue limits, or provider fallback behavior.
- No direct changes or migrations on dev0 or another remote database.

## Resolved decisions

- Weight is a positive integer from 1 through 100 and defaults to 1.
- Both OpenAI and Anthropic use the same smooth weighted round-robin semantics.
- Quota eligibility is evaluated before weighted selection.
- OpenAI routing skips busy tokens rather than waiting for the weighted token.
- OpenAI thread reuse remains pinned and outside weighted accounting.
- Provider selector state resets when token topology or configured weights change.
