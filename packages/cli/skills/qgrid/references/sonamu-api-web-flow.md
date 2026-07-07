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

Image-generation request logs add `is_image_generation`, `image_cost_usd`, and `image_cost_method`. The list view displays driver plus image cost as the total cost cell; the detail view shows driver cost and image cost separately and renders generated image data URLs from response/tool-step content.

Reference input images for image generation render in the detail view under the user prompt from the first synthetic `image_generation` step's `tool_args.inputImages`. Keep the prompt itself text-only, redact large base64 in request JSON views, and avoid rendering duplicate input previews for multi-output image turns.

## Verification

After API shape changes:

- Regenerate or inspect generated Sonamu files according to repo workflow.
- Run targeted API tests.
- Check web consumers compile against generated types.
- Verify dashboard display for null/legacy values when changing stored request log fields.
