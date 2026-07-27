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

## Skill and wiki consistency

`packages/cli/skills/qgrid` is the canonical qgrid skill. The CLI package ships this directory to consuming projects. The repository-local `.agents/skills/qgrid` directory is a checked mirror for agents working in this repository; do not edit the mirror as a separate source.

- Run `pnpm qgrid-docs:sync` after changing the canonical skill.
- Run `pnpm qgrid-docs:check` before finishing documentation or runtime-contract work.
- `docs/qgrid-doc-map.json` maps each durable topic to code, canonical skill references, and the matching Notion page.
- Code and tests remain the source of truth. Update the skill and Notion together when a code change alters a documented contract.
- Keep dated operational snapshots, internal server addresses, and other environment-specific facts in Notion. Keep reusable runtime contracts in the skill.

## Retract pre-release caveats after shipping

Documenting a contract before it ships is fine, but the caveat must be retracted once it does. Wording like "not deployed yet", "based on the working tree", "migration is still untracked", or "package version is still X" becomes a false statement the moment the release lands, and `pnpm qgrid-docs:check` will not catch it — that script validates the skill mirror and `docs/qgrid-doc-map.json` paths only, never Notion body text.

- When you add a pre-release caveat, record the retraction in the release page at the same time. Do not rely on memory.
- After a release, search the wiki for `미배포`, `배포되지 않았`, `working tree`, `untracked`, `아직`, and the previous version number.
- Update each page's baseline commit to the release commit. A stale baseline undermines every claim below it.
- This happened once already: caveats added 2026-07-23 survived the 2.4.9 and 2.5.0 releases and left six pages asserting the opposite of reality for several days.
