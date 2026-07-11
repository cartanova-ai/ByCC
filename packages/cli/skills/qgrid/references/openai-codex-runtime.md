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
- Image generation status

## Process model

OpenAI tokens use persistent Codex app-server workers.

- Dispatcher: `packages/api/src/utils/providers/openai/openai-dispatcher.ts`.
- Worker: `packages/api/src/utils/providers/openai/codex-worker.ts`.
- RPC client: `packages/api/src/utils/providers/openai/codex-rpc.ts`.
- Process command: `codex app-server --listen stdio://`.
- Workers per token: `QGRID_WORKERS_PER_TOKEN`, default 3, capped at 5.
- Worker id: `tokenId * 10 + workerIndex`.
- Worker home: `/tmp/qgrid-codex/${tokenId}-${workerIndex}` when `workerIndex` exists.
- Worker cwd: `${CODEX_HOME}/cwd`.

Workers are persistent. Turns are single-flight per worker (`busy` flag). When all eligible workers are busy, requests enter an in-memory queue.

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
- cleanup is lazy before creating a new thread.

There is no explicit close RPC for old ephemeral threads; qgrid removes them from the reuse map and stops routing turns to them.

## Queue and routing

OpenAI worker selection:

- Prefer reuse worker when a valid reuse coordinate exists. Successful reuse bypasses weighted selection and does not read or mutate its state.
- Otherwise cold selection is two-level: group quota-eligible ready active workers by token, keep only tokens with at least one idle worker, choose the token with the shared smooth weighted round-robin selector (`providers/common/smooth-weighted-round-robin.ts`, driven by `tokens.weight`), then rotate a per-token worker cursor inside the chosen token.
- Selection is work-conserving: a token whose workers are all busy is omitted from that selection round, so an idle lower-weight token receives the request immediately instead of waiting for the heavy token.
- If no eligible worker is idle, enqueue. Queue drain re-runs the same weighted cold selection; it must not hand the queue head to the worker that happened to finish first.
- Queue timeout: 60 seconds.
- Max queue size: 50.

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
