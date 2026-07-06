# Repo Map

Use this map to orient qgrid work quickly.

## Active packages

- `packages/api`: Sonamu server, qgrid API frame, provider dispatchers, token/request-log models, migrations, OAuth, runtime integration.
- `packages/ai-sdk`: active public AI SDK provider and logger integration. Prefer this for public SDK behavior and examples.
- `packages/web`: dashboard UI. Usually depends on Sonamu-generated API clients and API model shape.
- `packages/cli`: global `qgrid` command, bundled server boot, dependency checks, DB preflight.
- `scripts` and `packages/api/scripts`: smoke tests, debug scripts, runtime probes.
- `docs`: local planning, diagnosis, and solution history. `docs/WORKFLOW.md` is the collaboration convention.

## Deprecated/context-only package

- `packages/sdk`: deprecated. Read only for historical context or migration clues. Do not implement new features, docs, or examples against this package unless explicitly asked for legacy compatibility.

## Runtime hot spots

- Provider router: `packages/api/src/application/qgrid/qgrid.dispatcher.ts`.
- Conversation/thread reuse: `packages/api/src/application/qgrid/conv-routing.ts`.
- Query API and SSE stream: `packages/api/src/application/qgrid/qgrid.frame.ts`.
- Request logging lifecycle: `packages/api/src/application/qgrid/qgrid-run-lifecycle.ts`.
- Token LISTEN/NOTIFY sync: `packages/api/src/application/qgrid/token-subscriber.ts`.
- Token trigger setup: `packages/api/src/application/qgrid/token-trigger-setup.ts`.
- OpenAI Codex runtime: `packages/api/src/utils/providers/openai/*`.
- Anthropic Claude Code runtime: `packages/api/src/utils/providers/anthropic/*`.
- Cost/usage accounting: `packages/api/src/utils/providers/common/model-cost.ts`.
- Tool-call emulation: `packages/api/src/application/qgrid/tool-emulation.ts`.

## Web/Sonamu hot spots

- Entity definitions: `packages/api/src/application/**/**.entity.json`.
- API models/types: `packages/api/src/application/**/**.model.ts`, `*.types.ts`.
- Generated API files: `packages/api/src/application/sonamu.generated*`, `packages/web/src/services` when present, generated route/client files.
- Dashboard components: `packages/web/src/components/qgrid/*`.
- Dashboard routes: `packages/web/src/routes/*`.
