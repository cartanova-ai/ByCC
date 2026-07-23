# Provider Runtime Differences

Use this reference when comparing OpenAI and Anthropic behavior, debugging provider-specific bugs, or reviewing cross-provider changes.

| Topic | OpenAI via Codex | Anthropic via Claude Code |
|---|---|---|
| Process lifetime | Persistent `codex app-server` workers | Fresh `claude` process per request |
| Worker pool | Autoscaling pool per token, default 5–15 and hard-capped at 20 | No workers; in-memory token pool only |
| Worker id | `tokenId * 100 + workerIndex` | `tokenId` |
| Epoch | Worker spawn counter; changes on restart | Always `0` |
| Request concurrency | One turn per worker; queue when all eligible workers busy | Fresh process per request |
| Token selection | Smooth weighted RR picks a quota-eligible token with an idle worker, then a per-token worker cursor; reuse bypasses weights | Smooth weighted RR over quota-eligible tokens per request |
| Model routing | `openai/*`; qgrid strips provider prefix before provider call | `anthropic/*`; provider canonicalizes model and strips prefix/`[1m]` |
| Prefix-less models | Fallback not implemented | Fallback not implemented |
| Thread/session | Ephemeral Codex thread stored in worker memory | Fresh Claude `--session-id` per request |
| `sessionKey` | AI SDK stores and replays `threadCoord` for thread reuse | AI SDK intentionally disables storage/replay |
| Multi-turn | Reuse sends delta input to existing Codex thread; cold fallback injects full history | Fresh spawn receives flattened full history through stream-json |
| Cache key | Codex conversation/thread id is prompt-cache affinity | Anthropic prefix cache via Claude Code; fresh spawn still can cache stable prefixes |
| Built-in tools | Codex tools/apps/plugins/skills disabled by worker config | Claude tools disabled via `--tools ""`; `StructuredOutput` allowed only for schema |
| AI SDK tools | Emulated via qgrid structured output schema, then mapped to AI SDK `tool-call` content | Same emulation path; not native Claude Code tools |
| Structured output | Codex `outputSchema` passed to `turn/start`; schema changes can affect prefix cache | Claude `--json-schema` through `StructuredOutput` tool; strict schemas required |
| Usage accounting | Codex usage already reports `inputTokens` including cached input | Native Anthropic categories are mutually exclusive; qgrid sums them into total input |
| Cost source | qgrid model price fallback | Prefer Claude Code `total_cost_usd`, else qgrid price fallback |
| Settings isolation | Per-worker `CODEX_HOME` and config.toml | Shared project cwd plus per-token `CLAUDE_CONFIG_DIR` |
| Streaming close | Can interrupt Codex turn with `turn/interrupt` | Abort kills the fresh child process |
| Image generation | Implemented as an opt-in Codex `image_generation` tool path; non-stream only | Explicitly unsupported |

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

`qgrid.dispatcher.ts` maps this into `QueryOutput`, applies tool-call emulation, calculates fallback cost, and issues a client-facing `QgridThreadCoord` by adding `systemHash`.

Both providers receive strictified output schemas from `buildStrictOutputSchema`.

Tool calling uses this shared strict-schema path. It is not native provider tool calling on either route.
