# Provider Runtime Differences

Use this reference when comparing OpenAI and Anthropic behavior, debugging provider-specific bugs, or reviewing cross-provider changes.

| Topic | OpenAI via Codex | Anthropic via Claude Code |
|---|---|---|
| Process lifetime | No child process; direct HTTPS/SSE request | Fresh `claude` process per request |
| Worker pool | None; in-memory token pool only | None; in-memory token pool only |
| Worker id | Legacy coordinate field carries token id | `tokenId` |
| Epoch | Legacy compatibility value; not a process generation | Always `0` |
| Request concurrency | Uncapped; stateless HTTPS/WS request per call | Uncapped; fresh process per request |
| Token selection | Smooth weighted RR over quota-eligible tokens; valid affinity may prefer its token | Smooth weighted RR over quota-eligible tokens per request |
| Model routing | `openai/*`; qgrid strips provider prefix before provider call | `anthropic/*`; provider canonicalizes model and strips prefix/`[1m]` |
| Prefix-less models | Fallback not implemented | Fallback not implemented |
| Effort vocabulary | Codex catalog levels `low`..`ultra` (Astra/Sol/Terra through `ultra`, Luna through `max`); public-API `none`/`minimal` absent | Claude Code `--effort` levels `low`..`max`; per-model caps handled by Claude Code |
| Unsupported effort | Server drops it silently before the request (`resolveOpenAIEffort`), backend default applies | Server drops it silently (`resolveAnthropicEffort`), qgrid default `low` applies |
| Thread/session | No provider thread retained | Fresh Claude `--session-id` per request |
| `sessionKey` | AI SDK derives and replays opaque `prompt_cache_key` affinity | AI SDK intentionally disables storage/replay |
| Multi-turn | Full Responses-format history is sent on every request | Fresh spawn receives flattened full history through stream-json |
| Cache key | Opaque model-scoped affinity key plus stable serialized prefix | Anthropic prefix cache via Claude Code; fresh spawn still can cache stable prefixes |
| Built-in tools | Direct Responses request includes only requested qgrid tools/options | Claude tools disabled via `--tools ""` on every call |
| AI SDK tools | Emulated via qgrid structured output schema, then mapped to AI SDK `tool-call` content | Emulated via envelope contract rendered as prompt text (SON-532); reply parsed by `parseEnvelope`; not native Claude Code tools |
| Structured output | Strict JSON schema is sent in the direct Responses request; schema changes can affect prefix cache | Schema delivered as prompt text appended to the system prompt (no `--json-schema`, no strictify); server strips fences; validation is the consumer's |
| Usage accounting | Responses usage reports input including cached input | Native Anthropic categories are mutually exclusive; qgrid sums them into total input |
| Cost source | qgrid model price fallback | Prefer Claude Code `total_cost_usd`, else qgrid price fallback |
| Settings isolation | Per-token credentials in memory | Shared project cwd plus per-token `CLAUDE_CONFIG_DIR` |
| Streaming close | `AbortSignal` cancels queue wait, retry delay, or `fetch` | Abort kills the fresh child process |
| Image generation | Implemented as an opt-in direct Responses `image_generation` tool path; non-stream only | Explicitly unsupported |

## Routing contract

Provider routing happens in `packages/api/src/application/qgrid/qgrid.dispatcher.ts`.

- `openai/<model>` routes to `OpenAIDispatcher`.
- `anthropic/<model>` routes to `AnthropicDispatcher`.
- models without provider prefix produce "Direct LLM API fallback not implemented".

Do not silently route prefix-less Claude model names such as `claude-sonnet-4-6` to Anthropic. Tests intentionally guard against this.

## Shared contracts

Both providers return `GenerateResult` with:

- `text`
- `tokenName`
- `usage`
- `durationMs`
- optional `ttftMs`
- optional provider cost
- canonical `model`
- `threadCoord`

`qgrid.dispatcher.ts` maps this into `QueryOutput`, applies tool-call emulation, calculates fallback cost, and keeps the legacy `QgridThreadCoord` response shape for opaque OpenAI cache affinity.

Both providers receive strictified output schemas from `buildStrictOutputSchema`.

Tool calling uses this shared strict-schema path. It is not native provider tool calling on either route.
