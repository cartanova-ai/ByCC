# Docs Workflow

Use this reference for qgrid planning, diagnosis, and review workflow.

The project workflow is documented in `docs/WORKFLOW.md`.

## Standard flow

1. Brainstorm and plan before substantial work.
2. Store local docs under `docs/` using existing directories:
   - `docs/brainstorms/`
   - `docs/plans/`
   - `docs/diagnosis/`
   - `docs/solutions/`
3. Use peer review for plans and docs when requested.
4. Accept review feedback by default unless there is a concrete tradeoff-based reason not to.

## Existing docs are context

Before changing runtime-sensitive areas, search `docs/diagnosis`, `docs/solutions`, and recent `docs/plans` for prior decisions. qgrid has important historical decisions around:

- Codex thread reuse and prompt cache.
- Claude Code fresh spawn.
- structured output strictness.
- Anthropic usage categories.
- request log cache hit metrics.
- quota threshold routing.
- token isolation and auth env leaks.

Do not copy stale docs blindly. Use docs to identify decisions and then verify against current code.

When a repo doc establishes or changes durable rationale for a qgrid feature, reflect the stable decision in `references/decision-rationale.md`. Keep the skill reference as a compact index of why the decision exists and where the source docs live; do not copy full plans or brainstorms into the skill.
