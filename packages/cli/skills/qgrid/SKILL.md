---
name: qgrid
description: Work on the qgrid repository, an LLM subscription-token proxy with OpenAI Codex app-server workers, Anthropic Claude Code fresh-spawn runtime, AI SDK provider compatibility, Sonamu API/web generation, token routing, prompt-cache behavior, request logging, quota thresholds, and dashboard flows. Use when implementing, debugging, reviewing, or planning qgrid code, docs, migrations, provider integrations, CLI/runtime behavior, request logs, or SDK behavior.
---

# Qgrid

## Start Here

Use this skill for qgrid repository work. Treat qgrid as a runtime-contract-heavy system: model input travels through the active AI SDK provider, Sonamu API, provider dispatcher, provider-specific runtime, response mapping, request logging, and dashboard display.

Before changing code, identify the affected path:

- Public AI SDK provider: read `references/ai-sdk-provider-contract.md`.
- CLI startup, env vars, server boot, OAuth callback URL: read `references/cli-env-and-server-boot.md`.
- OpenAI models or Codex worker/thread/cache behavior: read `references/openai-codex-runtime.md`.
- Anthropic models or Claude Code spawn/stream-json behavior: read `references/anthropic-claude-code-runtime.md`.
- Token registration, OAuth, token sync, active/inactive behavior, quota thresholds, or weighted token routing: read `references/token-auth-quota-lifecycle.md`.
- Provider comparisons, routing, or cross-provider bugs: read `references/provider-runtime-differences.md`.
- Tool calling, AI SDK multi-step loops, or tool-call request logs: read `references/tool-calling-and-multiturn.md`.
- `sessionKey`, `threadCoord`, prompt cache metrics, usage accounting, or cost: read `references/prompt-cache-and-usage.md`.
- Design rationale, prior decisions, or "why is this feature shaped this way?": read `references/decision-rationale.md`.
- Dashboard changes: read `references/sonamu-api-web-flow.md`.
- Request log lifecycle, tool-call steps, telemetry/logger behavior: read `references/request-log-run-lifecycle.md`.
- Choosing tests, smoke scripts, or debugging common runtime errors: read `references/verification-and-debugging.md`.
- Project planning/review/documentation workflow: read `references/docs-workflow.md`.
- Repository orientation: read `references/repo-map.md`.

## Setup Guardrails

When helping a user set up local `@cartanova/qgrid-ai-sdk`, `createQgridLogger`, or qgrid CLI-backed workflows, ensure request-log project naming is configured. Check for `QGRID_PROJECT_NAME` in the calling app/runtime environment or `projectName` in qgrid provider/logger config. If neither is present, ask the user for a stable project/workflow name or add the obvious repository/app name when the surrounding setup convention makes that appropriate.

Prefer `QGRID_PROJECT_NAME` as the project-wide default. Use config `projectName` only for a deliberate per-call/per-provider override. Do not add `projectName` or `project_name` under `providerOptions.qgrid`; current code does not read it there.

## Non-Negotiable Boundaries

- Use `packages/ai-sdk` as the active public SDK surface.
- Treat `packages/sdk` as deprecated. Read it only for legacy context or migration clues. Do not add new examples or features on top of it unless explicitly asked for legacy work.
- Route provider models by prefix: `openai/*` goes to the OpenAI Codex runtime, `anthropic/*` goes to the Anthropic Claude Code runtime. Prefix-less model fallback is not implemented.
- Treat dashboard work as Sonamu API/model/generated-client/web work, not isolated frontend work.
- Keep OpenAI Codex built-in tools, apps, plugins, skills, web search, shell, and environment instruction blocks disabled unless the user explicitly asks for agentic Codex behavior.
- Treat OpenAI image generation as an opt-in Codex `image_generation` tool path. Inspect current code before modifying it; it is not a direct Images API call and its image cost is an estimate.

## Verification

Choose verification by blast radius:

- Type/lint/format: `pnpm check`.
- Package tests: use the relevant package test command or targeted Vitest files.
- Provider runtime changes: run targeted tests for `packages/api/src/utils/providers/**` and, when practical, the relevant smoke script in `scripts/` or `packages/api/scripts/`.
- AI SDK changes: run `packages/ai-sdk` tests and inspect generated request payload behavior.
- Sonamu API/model changes: check generated files and both API and web consumers.

Do not rely on one provider's behavior to infer the other provider's behavior. OpenAI/Codex and Anthropic/Claude Code have different process lifetimes, cache behavior, usage accounting, and structured-output paths.
