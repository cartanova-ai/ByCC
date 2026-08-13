# OpenAI Direct Codex Runtime

Use this reference before changing OpenAI transport, concurrency, routing, prompt-cache affinity, OAuth, quota lookup, image generation, or cancellation.

## Source files

- Dispatcher and permits: `packages/api/src/utils/providers/openai/openai-dispatcher.ts`.
- Direct client and transport interface: `openai-direct-client.ts`.
- Request, identity headers, and normalized events: `openai-backend-protocol.ts`.
- SSE decoding: `openai-sse.ts`.
- Direct PKCE OAuth and refresh: `openai-oauth.ts`, `openai-refresh.ts`.
- Direct quota lookup: `openai-quota.ts`.
- Provider integration and history: `packages/api/src/application/qgrid/qgrid.dispatcher.ts`, `conv-routing.ts`.

## Private backend boundary

OpenAI requests go directly to `https://chatgpt.com/backend-api/codex/responses` with an HTTPS `POST`. The response is an SSE stream. Qgrid sends the subscription bearer token, ChatGPT account id, content negotiation fields, and Codex CLI `originator` and `User-Agent` identity headers.

This is a private ChatGPT backend, not a documented public API. Its URL, accepted fields, required headers, event shapes, quota response, and availability can change without notice. Unit tests use mocked HTTP/SSE fixtures. Do not describe those tests as live provider verification.

`QGRID_OPENAI_TRANSPORT=https|websocket` selects the transport once when dispatcher configuration is resolved; WebSocket is the default and other values fail fast. WebSocket mode scheme-swaps the Responses HTTPS URL to `wss` and reuses one connection for sequential requests with the same prompt-cache affinity. Requests without cache affinity use one connection each. HTTPS remains available but does not preserve prompt-cache connection affinity. Qgrid does not replay ambiguous requests. Only a definitively rejected 401 handshake may refresh credentials and reconnect once.

The active HTTPS/SSE request receives the composed caller/timeout signal. Qgrid never replays a POST after a transport, 429, or 5xx failure because acceptance is ambiguous. A 401 may refresh credentials and retry once because the backend rejected that attempt.

## Request and stream behavior

Every request sends `store: false`, `stream: true`, full Responses-format history, and `include: ["reasoning.encrypted_content"]`. Optional reasoning, verbosity, service tier, structured-output schema, image generation, and `prompt_cache_key` fields are added when requested.

`normalizeOpenAISSE` handles chunk boundaries and converts private backend events into qgrid's normalized text, output-item, image, usage, completion, and error events. The HTTPS transport may retry a failure only before any visible event. It refreshes credentials once on a pre-event 401. Once output is visible, an error is returned rather than replaying a request that may already have produced output.

The caller's `AbortSignal` is passed through permit acquisition, retry delay, and `fetch`. Cancellation removes a queued item or aborts active transport work; permits are released in `finally`.

## Token permits, routing, and queue

Concurrency is token-level. Each active OpenAI token owns a bounded number of permits from the existing OpenAI capacity settings; permits are counters, not child processes.

New requests use smooth weighted round-robin among active, quota-eligible tokens with a free permit. Token weights set relative routing share. A preferred token from cache affinity is attempted first when it remains eligible; otherwise correctness falls back to normal weighted selection.

When no eligible permit is free:

- the queue accepts at most 50 items;
- each item waits at most 60 seconds by default;
- abort removes and rejects the item immediately;
- releasing a permit drains queued work;
- shutdown or loss of all active tokens rejects queued work.

Quota lookup failures fail open. A successful lookup over a token's configured threshold excludes that token until the cached usage is refreshed.

## Full-history replay and cache affinity

Qgrid no longer retains an OpenAI provider thread. It sends the full conversation history on every turn. The AI SDK derives a model-scoped opaque value from `sessionKey`; the server validates and forwards it as `prompt_cache_key`.

The legacy `threadCoord` and `runContext` shape remains for compatibility, but it carries cache affinity rather than a process or provider-thread address. Do not infer worker lifetime, thread presence, or delta-only replay from `workerId`, `threadId`, or `epoch`.

Stable affinity can improve provider prompt-cache reuse only when the serialized prefix remains stable. System prompt, tool/schema framing, message order, and model changes can still prevent a cache hit. Image generation sends full input and retains no provider conversation state.

## OAuth, identity, refresh, and quota

OpenAI browser login is implemented directly with authorization-code PKCE:

1. Generate verifier, SHA-256 challenge, and state.
2. Build the OpenAI authorize URL with Codex CLI-compatible client, scope, originator, and simplified-flow fields.
3. Validate pending state on callback.
4. Exchange the code directly at `https://auth.openai.com/oauth/token`.
5. Parse account id and plan claims, then store access, refresh, and id tokens.

Refresh posts the stored refresh token directly to the token endpoint, deduplicates concurrent refreshes, and persists rotated credentials. Generation sends Codex CLI identity headers built by `buildCodexIdentityHeaders`.

Quota is fetched directly from `https://chatgpt.com/backend-api/wham/usage` with the same identity headers. Qgrid normalizes the primary usage window and caches it for 60 seconds. This private response format has the same stability warning as the Responses endpoint.

## Usage and images

OpenAI usage reports total input, cached input, output, reasoning, and total tokens for the request. Preserve cached input as a subset of input; do not add it to input again when computing cache-hit rate.

Image generation is opt-in and non-stream at the AI SDK interface. The backend still delivers its response through SSE. Returned base64 images become AI SDK PNG file parts. Recorded image cost remains an estimate based on qgrid's configured public image price table because this route does not expose exact image-tool billing.
