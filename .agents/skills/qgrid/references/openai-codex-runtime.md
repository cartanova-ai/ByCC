# OpenAI Codex Runtime

Use this reference before changing OpenAI provider behavior, Codex worker lifecycle, thread reuse, cache behavior, OAuth refresh, image-generation gates, or quota routing.

## Contents

- Process model
- Codex configuration
- Initialization and auth
- Thread and turn flow
- Thread retention
- Queue and routing
- Usage and notifications
- Streaming
- Image generation

## Process model

OpenAI tokens use persistent Codex app-server workers.

- Dispatcher: `packages/api/src/utils/providers/openai/openai-dispatcher.ts`.
- Worker: `packages/api/src/utils/providers/openai/codex-worker.ts`.
- RPC client: `packages/api/src/utils/providers/openai/codex-rpc.ts`.
- Process command: `codex app-server --listen stdio://`.
- Workers per token: autoscaling defaults to 1–3 workers per active token, with a hard cap of 20.
- Worker id: `tokenId * 100 + workerIndex`.
- Worker home: `/tmp/qgrid-codex/${tokenId}-${workerIndex}` when `workerIndex` exists.
- Worker cwd: `${CODEX_HOME}/cwd`.

Workers are persistent. Turns are single-flight per worker (`busy` flag). When all eligible workers are busy, requests enter an in-memory queue.

Autoscaling is enabled unless `QGRID_OPENAI_AUTOSCALE` is `"false"` or `"0"`. It evaluates the pool every 5 seconds by default, starts scale-down after 10 idle minutes, and refuses scale-up when either memory guard would be crossed:

- estimated qgrid worker RSS: `0.71 + 0.157 * totalWorkerCount` GiB, limited to 16 GiB by default;
- current host available memory at scale-up evaluation time, required to be at least 20 GiB by default.

All sizing and memory limits can be overridden with the environment variables listed in `cli-env-and-server-boot.md`.

Pool health maintenance is separate from demand autoscaling:

- Every active token maintains the configured minimum worker slots even when demand autoscaling is disabled.
- An initial all-worker spawn failure is retried by the periodic pool evaluation.
- A transiently restarting worker keeps its slot so qgrid does not create a duplicate process or worker index.
- After a worker exhausts its three restart attempts, it emits a one-shot terminal signal. The dispatcher removes that exact worker and repairs the token back to its configured minimum.
- Minimum repair follows the same operator commitment as startup and is not blocked by the above-min memory guards. Demand expansion above the minimum still uses both guards.
- A broken token's failed minimum repair does not block healthy tokens from scaling up or down.

## Codex configuration

qgrid writes a worker-local `config.toml` under `CODEX_HOME` before spawning Codex. The intent is to use Codex as a plain generation backend, not as a coding agent.

Disabled by config:

- web search
- shell tool
- tool search/suggest
- multi-agent
- image generation by default
- apps/plugins
- view_image
- bundled skills/instructions
- permissions/apps/environment instruction blocks

Spawn env is intentionally small:

- `PATH`
- `TMPDIR`
- `CODEX_HOME`
- `CODEX_EXEC_SERVER_URL=none`

Do not re-enable built-in Codex tools/instructions unless the user explicitly asks for agentic Codex behavior.

## Initialization and auth

Worker initialization:

1. Spawn Codex app-server over stdio.
2. Create `CodexRpcClient`.
3. Send `initialize`.
4. Login with ChatGPT/OAuth credentials.
5. Bind Codex server-request `account/chatgptAuthTokens/refresh` to qgrid's token refresh handler.

If Codex asks to refresh ChatGPT auth tokens, qgrid handles it through `handleChatgptAuthTokensRefresh(tokenId)`.

## Thread and turn flow

Cold path:

1. `thread/start` with `ephemeral: true`.
2. `baseInstructions` is a minimal assistant prompt.
3. `developerInstructions` carries the qgrid system prompt.
4. Optional `thread/inject_items` injects full history.
5. `turn/start` runs current input.

Reuse path:

1. qgrid verifies the incoming `threadCoord`.
2. Dispatcher reacquires the exact worker by `workerId`.
3. It checks worker readiness, active status, epoch, thread presence, and quota threshold.
4. It waits up to 5 seconds for that worker to become free.
5. It calls `turn/start` on the existing thread with delta input only.

Thread metadata is stored only inside the worker process. Worker restart increments `epoch` and clears thread metadata. Thread reuse must fall back cold if epoch or thread lookup fails.

## Thread retention

Worker thread metadata:

- idle TTL: 10 minutes.
- max threads per worker: 16.
- cleanup runs from the dispatcher's periodic health evaluation and also lazily before creating a new thread.

Eviction is two-sided. Removing a thread from the reuse map only stops qgrid from routing turns to it; the thread itself stays resident inside the codex process. Codex auto-unloads a thread from memory only when it has zero subscribers and has been idle for 30 minutes (`THREAD_UNLOADING_DELAY`, hardcoded upstream), and `thread/start` auto-registers the creating connection as a permanent subscriber. So on every eviction (TTL sweep or LRU cap) qgrid also sends fire-and-forget `thread/unsubscribe`, which arms that 30-minute unload. Image one-shot threads never enter the reuse map, so they are unsubscribed immediately after their turn completes or fails.

Periodic cleanup scans only ready, idle workers. It must never unsubscribe from a busy worker because turn notifications would stop reaching qgrid and the request could hang. Reusable thread `lastUsedAt` is refreshed when a turn finishes, so a long-running turn receives a full idle TTL after completion. The periodic pass keeps up to 16 threads; the pre-create lazy pass reserves one slot so the newly created thread still leaves the worker at no more than 16.

Once `thread/start` returns, `createThread` owns cleanup until history injection and reuse-map registration finish. Any failure during that partial-creation window removes tentative metadata and immediately unsubscribes the thread. Otherwise neither turn cleanup nor the lazy sweep can see it, and repeated failed cold-history requests accumulate permanently subscribed threads.

Do not send turns to an unsubscribed thread: its notifications no longer reach qgrid's connection, so the turn would hang until timeout. Map removal must always precede or accompany unsubscribe.

`thread/archive` is not usable here: it requires a rollout file and ephemeral threads have none ("no rollout found"). Without unsubscribe, worker RSS grows without bound (measured ~2 MiB resident per 512 KB injected history; dev0 incident reached ~1.28 GB per worker in two days).

## Queue and routing

OpenAI worker selection:

- Prefer reuse worker when a valid reuse coordinate exists. Successful reuse bypasses weighted selection and does not read or mutate its state.
- Otherwise cold selection is two-level: group quota-eligible ready active workers by token, keep only tokens with at least one idle worker, choose the token with the shared smooth weighted round-robin selector (`providers/common/smooth-weighted-round-robin.ts`, driven by `tokens.weight`), then rotate a per-token worker cursor inside the chosen token.
- Selection is work-conserving: a token whose workers are all busy is omitted from that selection round, so an idle lower-weight token receives the request immediately instead of waiting for the heavy token.
- If no eligible worker is idle, enqueue. Queue drain re-runs the same weighted cold selection; it must not hand the queue head to the worker that happened to finish first.
- If active token metadata exists but every worker is starting, restarting, or otherwise unavailable, enqueue instead of returning `NO_OPENAI_WORKERS`. Queue admission immediately requests both a drain and pool evaluation so a recovered worker cannot lose its wake-up.
- Return `NO_OPENAI_WORKERS` immediately only when there is no active OpenAI token candidate. A zero-ready recovery request still uses the normal 60-second queue timeout.
- Queue timeout: 60 seconds.
- Max queue size: 50.

Scale-down uses one pool-wide quiet clock, not per-worker timers. With an empty queue and no new request for `scaleDownIdleMs`, each evaluation removes at most one highest-index idle excess worker per token. Busy workers are never removed, and repeated evaluations stop exactly at the configured `minWorkersPerToken`.

Quota threshold:

- `quota_threshold` is stored on tokens.
- Dispatcher reads rate limits through a ready worker.
- Rate limit reads are cached for 60 seconds.
- Lookup failure is fail-open.
- If all ready active tokens are over threshold, throw `QuotaThresholdExceededError`.

## Usage and notifications

Codex RPC notifications drive result collection:

- `item/agentMessage/delta`: text deltas and TTFT.
- `item/completed`: final text and image-generation results.
- `thread/tokenUsage/updated`: token usage.
- `turn/completed`: duration and terminal status.
- `error`: terminal error.

When using thread reuse, use `tokenUsage.last`, not `tokenUsage.total`, for request logs. `.total` is conversation cumulative and mixes previous turns, which corrupts per-request cache hit metrics.

## Streaming

Streaming uses the same worker/thread execution with callbacks:

- `onThreadId` emits the thread id when a new thread is created.
- `onTurnId` emits turn id after `turn/start`.
- qgrid can interrupt OpenAI turns on SSE close by calling `turn/interrupt` across ready workers.

## Image generation

Image generation is OpenAI/Codex-only and implemented as an opt-in Codex `image_generation` tool call. It is not a direct OpenAI Images API call from qgrid.

- It is opt-in through `imageGeneration`.
- `imageGenerationOptions` carries quality/size hints and the cost-estimation basis.
- It is non-stream only; streaming path rejects it.
- It always uses a cold one-shot thread and does not issue a reusable coordinate.
- It enables `features.image_generation` only on that thread; global config remains disabled.
- It swaps the normal "text only" base instruction for an image-permitting instruction on that thread.
- It gates on provider capability and model multimodality.
- AI SDK reference images are accepted only on this image-generation path. They arrive as qgrid `input` image data URLs and should be compressed/resized by callers before JSON transport.
- Failure kinds are `gate`, `not_called`, and `incomplete`.
- Codex notifications expose image items through `item/started` and `item/completed`; qgrid treats non-empty base64 `result` as the completion signal, not the item `status` string.
- Completed images are surfaced as qgrid `image` content parts and AI SDK `file` parts with `mediaType: "image/png"`.
- qgrid uses `gpt-image-2` as the image-tool pricing/model assumption. Codex does not expose exact image tool token usage, so `image_cost_usd` is an estimate from the public price table, not exact billing.
- Codex may return multiple completed image outputs. qgrid maps each one to a separate image content part and a synthetic `image_generation` request-log tool step.

Before modifying this area, inspect latest docs/plans/brainstorms and current tests.
