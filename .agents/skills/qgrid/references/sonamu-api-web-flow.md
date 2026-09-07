# Sonamu API And Web Flow

Use this reference for dashboard/API changes.

qgrid dashboard work is usually a Sonamu API/model/generated-client/web change, not an isolated React change.

## Full path to inspect

1. Entity and model definitions in `packages/api/src/application/**`.
2. API frame/model methods decorated with `@api` or `@stream`.
3. Generated Sonamu files such as `packages/api/src/application/sonamu.generated*`.
4. Web API consumers and generated client/types.
5. Dashboard routes/components in `packages/web/src/**`.

## Common patterns

- Entity fields live in `*.entity.json`.
- Model methods live in `*.model.ts`.
- API frame methods for qgrid live in `qgrid.frame.ts`.
- i18n generated files may change when entity labels or static data change.
- Web components under `packages/web/src/components/qgrid` consume generated API shapes.
- The main dashboard sidebar version should stay synced to `packages/cli/package.json`. `packages/web/vite.config.ts` reads that package version and exposes it as `__QGRID_CLI_VERSION__`; `Sidebar.tsx` displays it.
- Runtime settings use the curated `listSettings`, `setSetting`, and `resetSetting` API methods. Do not expose the model's generic `save` or `del` methods: they bypass the settings schema validation, process-local cache update, and runtime change handler.
- The Slack bot token is returned to the authenticated settings dashboard for its reveal toggle. Preserve the deployment authentication boundary when changing this response; do not describe the value as masked unless the API contract is changed to match.

## Migration workflow

Sonamu entity definitions are the source of truth for managed database schema.
These commands apply only inside the qgrid source repository. Downstream projects must use
their own configured task and tool runner.

1. Change the relevant `*.entity.json` files.
2. Run `mise exec -- pnpm --dir packages/api sonamu migrate status` and inspect `preparedCodes`.
3. Run `mise exec -- pnpm --dir packages/api sonamu migrate generate`.
4. Inspect the generated, table-scoped migration files without rewriting them by hand.
5. Apply them through Sonamu's migration target flow or qgrid's startup migration runner.
6. Re-run migration status and require `pending: []` and `preparedCodes: []`.

Do not hand-author a migration that Sonamu can derive from entity changes. If generation cannot represent the required operation, stop and make the exception explicit before changing migration code or database state. Never delete or edit a migration that has already shipped to another environment.

## Request log dashboard

Request log changes usually touch:

- `request-log.entity.json`
- `request-log.model.ts`
- `request-log.types.ts`
- `request-log-step.*`
- `qgrid-run-lifecycle.ts`
- `RequestLogTable.tsx`
- `routes/requests/show.tsx`

Check list and detail views. Avoid loading large text columns in list views unless intentionally needed.

For new request logs, the existing `requested_model_name` and `model_name` fields store full `provider/model` values; there is no separate request-log provider column. A running parent stores the requested id and keeps `model_name = NULL`, but the dashboard must treat `status` as authoritative and render only an explicit running state until the request finishes. Completed rows keep the existing requested-to-serving fallback display. If an error/aborted row has only a requested model, show that value explicitly as requested rather than as a serving model or an unknown placeholder. Legacy prefixless rows remain valid and are not backfilled.

Provider-qualified ids widen `model_name` and `requested_model_name` from 50 to 255 characters on both the parent and step entities. Generate and inspect the Sonamu migration, and apply it before starting the new server. The width migration must not rewrite legacy model values or add a provider column. Keep generated API/web types synchronized through Sonamu rather than editing them by hand.

Image-generation request logs add `is_image_generation`, `image_cost_usd`, and `image_cost_method`. The list view displays driver plus image cost as the total cost cell; the detail view shows driver cost and image cost separately and renders generated image data URLs from response/tool-step content.

Structured output visibility: the list has an `Fmt` column (`json` badge from `is_structured` vs `text`) and a `broken` badge driven by `response_json_ok = false`; there is no broken-JSON list filter. At review time, all 114,647 succeeded structured rows had `response_json_ok = true` and zero false rows existed; the unindexed zero-result lookup scanned 1,286,016 rows and took about 3 seconds. Before reinstating the filter, validate the failure-signal semantics and index the predicate. The detail page shows a dark Response Type panel (zod expression by default, `type` declaration via toggle) rendered server-side from the stored `json_schema`. Plain-text rows render no panel. Rows written by pre-2.7.2 servers show `text`.

Tool contract visibility: the detail page renders a Tools panel between Response Type and Steps for requests whose `tools` is non-empty. It starts collapsed and its header shows the tool count plus a responsive, truncated name list built from the detail subset — collapsed views issue no extra query. Expanding fires `toolsView` once and caches it for that request id, since a stored tool contract never changes. Each card shows the name, the full description, the parameter count, and a compact display-only zod shape; enum values past the sixth collapse to `/* +N */`, with the full shape reachable through hover and keyboard focus. All JSON Schema conversion happens server-side — the web renders completed strings and holds no schema logic.

Chat token targeting: the dashboard chat panel can pin a conversation to one account. It defaults to automatic distribution and lists only active tokens whose provider matches the selected model, sending the choice as `tokenName` so the request lands on exactly that account with no fallback. Changing either the model or the token resets the existing conversation coordinates, because a thread's prompt cache belongs to the account that built it. A selection that disappears — deactivated or deleted — is cleared automatically, but the selection is preserved while the token list is still loading so a slow fetch does not silently reset the user's choice.

Chat model presets: the model `<select>` lists the served subset of `QgridSupportedModel` grouped by provider (`MODEL_PRESET_GROUPS` in `ChatWidget.tsx`), newest first, and defaults to `anthropic/claude-fable-5-1`. Ids that the ChatGPT-subscription Codex route no longer serves (`gpt-5.4` and `gpt-5.4-mini` retired 2026-08-31 with `gpt-5.6-terra` / `gpt-5.6-luna` as replacements; `gpt-5.2` and `gpt-5.3-codex` removed earlier) and the catalog-less `claude-sonnet-4-7` stay in the SDK type but are excluded here. web does not depend on ai-sdk, so a new model must be added in both places. `openai/gpt-6-astra` is included in the OpenAI group; adding it does not change the default model.

The monit tab's vitals strip shows per-provider in-flight counts, an in-flight sparkline, token chips with quota gauges (fed by the dispatcher's 60-second rate-limits cache; `resetsAt` arrives as ms epoch), and a 1-hour per-provider request/error/cache-hit stats line polled separately every 30 seconds.

Reference input images for image generation render in the detail view under the user prompt from the first synthetic `image_generation` step's `tool_args.inputImages`. Keep the prompt itself text-only, redact large base64 in request JSON views, and avoid rendering duplicate input previews for multi-output image turns.

## Verification

After API shape changes:

- Regenerate or inspect generated Sonamu files according to repo workflow.
- Run targeted API tests.
- Check web consumers compile against generated types.
- Verify dashboard display for null/legacy values when changing stored request log fields.
