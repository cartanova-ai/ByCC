---
name: qgrid
description: Work on the qgrid repository, an LLM subscription-token proxy with direct OpenAI private-backend HTTPS/SSE transport, Anthropic Claude Code fresh-spawn runtime, AI SDK provider compatibility, Sonamu API/web generation, weighted token routing, prompt-cache behavior, request logging, quota thresholds, and dashboard flows. Use when implementing, debugging, reviewing, or planning qgrid code, docs, migrations, provider integrations, CLI/runtime behavior, request logs, or SDK behavior.
---

# Qgrid

## Start Here

Use this skill for qgrid repository work. Treat qgrid as a runtime-contract-heavy system: model input travels through the active AI SDK provider, Sonamu API, provider dispatcher, provider-specific runtime, response mapping, request logging, and dashboard display.

Before changing code, identify the affected path:

- Public AI SDK provider: read `references/ai-sdk-provider-contract.md`.
- CLI startup, env vars, server boot, OAuth callback URL: read `references/cli-env-and-server-boot.md`.
- OpenAI direct transport, permits, routing, cache affinity, OAuth, or quota behavior: read `references/openai-codex-runtime.md`.
- Anthropic models or Claude Code spawn/stream-json behavior: read `references/anthropic-claude-code-runtime.md`.
- Token registration, OAuth, token sync, active/inactive behavior, quota thresholds, or weighted token routing: read `references/token-auth-quota-lifecycle.md`.
- Provider comparisons, routing, or cross-provider bugs: read `references/provider-runtime-differences.md`.
- Tool calling, AI SDK multi-step loops, or tool-call request logs: read `references/tool-calling-and-multiturn.md`.
- `sessionKey`, opaque affinity coordinates, prompt cache metrics, usage accounting, or cost: read `references/prompt-cache-and-usage.md`.
- Design rationale, prior decisions, or "why is this feature shaped this way?": read `references/decision-rationale.md`.
- Dashboard changes: read `references/sonamu-api-web-flow.md`.
- Request log lifecycle, tool-call steps, telemetry/logger behavior: read `references/request-log-run-lifecycle.md`.
- Choosing tests, smoke scripts, or debugging common runtime errors: read `references/verification-and-debugging.md`.
- Project planning/review/documentation workflow: read `references/docs-workflow.md`.
- Repository orientation: read `references/repo-map.md`.

## Setup Guardrails

When helping a user set up local `@cartanova/qgrid-ai-sdk`, `createQgridLogger`, or qgrid CLI-backed workflows, ensure request-log project naming is configured. Check for `QGRID_PROJECT_NAME` in the calling app/runtime environment or `projectName` in qgrid provider/logger config. If neither is present, ask the user for a stable project/workflow name or add the obvious repository/app name when the surrounding setup convention makes that appropriate.

Prefer `QGRID_PROJECT_NAME` as the project-wide default. Use config `projectName` only for a deliberate per-call/per-provider override. Do not add `projectName` or `project_name` under `providerOptions.qgrid`; current code does not read it there.

When writing AI SDK examples or setup code, import the public `QgridProviderOptions` type and apply `satisfies QgridProviderOptions` to the value under `providerOptions.qgrid`. AI SDK types the outer `providerOptions` as a generic JSON record, so it cannot infer qgrid's option names and values by itself. `QgridProviderOptions` is the inner qgrid namespace type, not the outer record type.

Request logging is enabled by default. Use `providerOptions.qgrid.logger: false` only for a call that must create zero qgrid request-log rows. The same option suppresses both qgrid's server-native logging and `createQgridLogger` telemetry logging for that generation; it does not disable generation, AI SDK tool execution, multi-step continuation, or OpenAI cache affinity. The old `logMode` input has been removed and must not appear in setup code or raw qgrid payloads.

## Non-Negotiable Boundaries

- Use `packages/ai-sdk` as the active public SDK surface.
- The old v1 SDK package (`packages/sdk`, `@cartanova/qgrid-sdk`) has been removed from the repository. It survives only as a deprecated npm artifact (1.9.0); do not resurrect it or write new code against it.
- Let the server infer single-turn versus tool-run request-log lifecycle. Do not recreate caller-selected logging modes in the SDK or API examples.
- Route provider models by prefix: `openai/*` goes to the OpenAI Codex runtime, `anthropic/*` goes to the Anthropic Claude Code runtime. Prefix-less model fallback is not implemented.
- Treat Fable 5 safety fallback as upstream Claude Code behavior, not qgrid routing: a classifier refusal can retry on Opus 4.8. Do not add a second qgrid retry. Preserve requested Fable versus actual serving Opus, fallback history, and provider-reported cost; a fresh Claude Code process means the fallback is not sticky across qgrid requests.
- Treat dashboard work as Sonamu API/model/generated-client/web work, not isolated frontend work.
- Prefer `getPuri()` for Sonamu model queries. Treat `getDB()` as a legacy escape hatch only when Puri cannot express the required query. Inside `@transactional` methods, all participating queries must use `getPuri()`; `getDB()` does not reuse Sonamu's ambient transaction connection.
- Never hand-author migration files for Sonamu-managed schema. Change the entity definition, inspect `sonamu migrate status`, and create migration files with `pnpm --dir packages/api sonamu migrate generate`. Inspect the generated files before applying them. If Sonamu cannot express a required schema change, stop and ask rather than silently replacing its workflow with a custom migration.
- Keep OpenAI Codex built-in tools, apps, plugins, skills, web search, shell, and environment instruction blocks disabled unless the user explicitly asks for agentic Codex behavior.
- Treat OpenAI image generation as an opt-in Codex `image_generation` tool path. Inspect current code before modifying it; it is not a direct Images API call and its image cost is an estimate.

## Verification

Choose verification by blast radius:

- Type/lint/format: `pnpm check`.
- Package tests: use the relevant package test command or targeted Vitest files.
- Provider runtime changes: run targeted tests for `packages/api/src/utils/providers/**` and, when practical, the relevant smoke script in `scripts/` or `packages/api/scripts/`.
- AI SDK changes: run `packages/ai-sdk` tests and inspect generated request payload behavior.
- Sonamu API/model changes: check generated files and both API and web consumers.

Do not rely on one provider's behavior to infer the other provider's behavior. OpenAI direct transport and Anthropic/Claude Code have different execution lifecycles, cache behavior, usage accounting, and structured-output paths.
