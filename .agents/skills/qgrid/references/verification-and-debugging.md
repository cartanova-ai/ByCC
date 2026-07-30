# Verification And Debugging

Use this reference to choose tests, smoke scripts, and first debugging targets for qgrid changes.

## Contents

- Package scripts
- Targeted test matrix
- Smoke scripts
- Common error triage
- Debugging rules

## Package Scripts

Root:

- `pnpm check`: oxlint plus oxfmt check for the repo.
- `pnpm build`: recursive package build.
- `pnpm dev`: parallel package dev servers.

API package `qgrid-api`:

- `pnpm --filter qgrid-api test`: Vitest run.
- `pnpm --filter qgrid-api test:watch`: standalone watch mode.
- `pnpm --filter qgrid-api build`: Sonamu build.
- `pnpm --filter qgrid-api sonamu`: run Sonamu CLI.

AI SDK package `@cartanova/qgrid-ai-sdk`:

- `pnpm --filter @cartanova/qgrid-ai-sdk test`.
- `pnpm --filter @cartanova/qgrid-ai-sdk build`.
- `pnpm --filter @cartanova/qgrid-ai-sdk e2e`.
- `pnpm --filter @cartanova/qgrid-ai-sdk e2e:tools-output`.
- `pnpm --filter @cartanova/qgrid-ai-sdk e2e:logger`.

CLI package `@cartanova/qgrid-cli`:

- `pnpm --filter @cartanova/qgrid-cli build`.
- `pnpm --filter @cartanova/qgrid-cli bundle` builds the API first and copies the server bundle.

Web package `qgrid-web`:

- `pnpm --filter qgrid-web dev`.
- `pnpm --filter qgrid-web preview`.

The old v1 SDK package (`packages/sdk`) has been removed from the repository; all public-SDK verification goes through `packages/ai-sdk`.

## Targeted Test Matrix

Choose by affected area:

| Area | Primary tests |
|---|---|
| AI SDK provider request/response mapping | `packages/ai-sdk/src/index.test.ts` |
| AI SDK logger integration | `packages/ai-sdk/src/logger.test.ts` |
| qgrid provider routing and strict schema | `packages/api/src/application/qgrid/qgrid.dispatcher.test.ts` |
| conversation/thread reuse routing | `packages/api/src/application/qgrid/conv-routing.test.ts` |
| tool-call emulation | `packages/api/src/application/qgrid/tool-emulation.test.ts`, `tool-emulation-schema.test.ts` |
| request-log run lifecycle | `packages/api/src/application/qgrid/qgrid-run-lifecycle.test.ts` |
| qgrid frame API behavior | `packages/api/src/application/qgrid/qgrid.frame.test.ts` |
| token subscriber and LISTEN/NOTIFY handling | `packages/api/src/application/qgrid/token-subscriber.test.ts` |
| token defaults/validation | `packages/api/src/application/token/token.model.test.ts`, `token.types.test.ts` |
| weighted routing selector | `packages/api/src/utils/providers/common/smooth-weighted-round-robin.test.ts` |
| token weight migration/trigger split | `packages/api/src/application/qgrid/token-weight-migration.test.ts`, `token-trigger-setup.test.ts` |
| boot order and startup migrations | `packages/api/src/server-bootstrap.test.ts`, `startup-migrations.test.ts` |
| request log queries/legacy normalization | `packages/api/src/application/request-log/request-log.model.test.ts` |
| OpenAI dispatcher routing/queue/quota/reuse | `packages/api/src/utils/providers/openai/openai-dispatcher.test.ts` |
| OpenAI Codex worker RPC/turn behavior | `packages/api/src/utils/providers/openai/codex-worker.test.ts` |
| OpenAI quota parser | `packages/api/src/utils/providers/openai/openai-quota.test.ts` |
| Anthropic dispatcher token/quota/session behavior | `packages/api/src/utils/providers/anthropic/anthropic-dispatcher.test.ts` |
| Anthropic Claude args/env/session isolation | `packages/api/src/utils/providers/anthropic/claude-session.test.ts` |
| Anthropic stream-json parsing/structured output | `packages/api/src/utils/providers/anthropic/stream-json-adapter.test.ts` |
| Anthropic model constants/1M suffix | `packages/api/src/utils/providers/anthropic/anthropic-constants.test.ts` |
| Anthropic quota parser | `packages/api/src/utils/providers/anthropic/anthropic-quota.test.ts` |
| shared cost accounting | `packages/api/src/utils/providers/common/model-cost.test.ts` |
| TTFT tracker | `packages/api/src/utils/providers/common/ttft.test.ts` |

Run focused Vitest files from the owning package when possible, then broaden if the change crosses package boundaries.

## Smoke Scripts

Smoke scripts assume a running qgrid server and real registered tokens. They can consume subscription quota; do not run them casually.

OpenAI direct qgrid API:

- `scripts/smoke-test-openai.ts`
- Requires qgrid server and active OpenAI token.
- Uses `QGRID_URL`, default `http://localhost:44900`.
- Covers health, text generation, structured output, and qgrid-native tool-call content.

Anthropic qgrid path:

- `packages/api/scripts/smoke-test-anthropic.ts`
- Requires active Anthropic OAuth token.
- Uses `QGRID_URL`, `QGRID_ANTHROPIC_MODEL`, `QGRID_ANTHROPIC_MODELS`.
- Optional flags include `--full`, `--legacy-full`, and `--structured-stream-probe`.

AI SDK structured output:

- `scripts/qgrid-structured-ai-sdk-smoke.ts`
- Uses local `packages/ai-sdk/src/index`.
- Env: `QGRID_URL`, `SMOKE_MODEL`, `SMOKE_CASES`, `SMOKE_REPEAT`.
- Uses AI SDK 6 `streamText` with `Output.object`; useful for structured-output regressions.

AI SDK tools plus structured output:

- `packages/ai-sdk/e2e/tools-structured-output.ts`
- This is the public-path release acceptance matrix: `qgrid()` HTTP/SSE,
  `generateText`/`streamText`, OpenAI/Anthropic, direct final answers, and one
  client-tool result followed by `Output.object`.
- It consumes real provider quota and requires the explicit
  `QGRID_REAL_PROVIDER_ACCEPTANCE=1` opt-in.
- Uses `QGRID_URL`, `QGRID_ACCEPTANCE_OPENAI_MODEL`, and
  `QGRID_ACCEPTANCE_ANTHROPIC_MODEL`. OpenAI direct-final coverage defaults to
  10 generate plus 10 stream attempts and can be changed with
  `QGRID_ACCEPTANCE_OPENAI_DIRECT_REPEATS_PER_MODE`. Request logs use the stable
  project name `qgrid-ai-sdk-tools-output-acceptance`.

Image generation:

- `packages/api/scripts/smoke-test-image-generation.ts`
- Human-initiated only.
- Requires active OpenAI token with image entitlement and applicable migration.
- Env: `QGRID_URL`, `QGRID_OPENAI_MODEL`.
- Not part of CI; it consumes ChatGPT subscription quota.

Other scripts under `scripts/smoke-test-*` and `scripts/debug-*` are ad hoc probes. Read the script header and env vars before running.

## Common Error Triage

`NO_OPENAI_WORKERS`:

- The request path returns this immediately only when there is no active OpenAI token candidate. If active metadata exists but all workers are temporarily unavailable, qgrid queues while pool health maintenance attempts recovery.
- Check active OpenAI tokens, worker startup/terminal-failure logs, Codex CLI availability, and `OpenAIDispatcher.readyWorkerCount`.
- If tokens were recently changed, inspect `TokenSubscriber` status and reconcile behavior.
- Repeated recovery spawn failures eventually surface as the normal queue timeout (`SERVER_BUSY`), not immediate `NO_OPENAI_WORKERS`.

`NO_ACTIVE_WORKERS`:

- OpenAI workers exist but active tokens were deactivated.
- Check token `active` state and token subscriber event handling.

`SERVER_BUSY`:

- OpenAI worker queue is full or a queued request timed out.
- Check `QGRID_OPENAI_MIN_WORKERS_PER_TOKEN`/`QGRID_OPENAI_MAX_WORKERS_PER_TOKEN`, worker readiness, long-running turns, and queue pressure.

`QuotaThresholdExceededError` or `quota_threshold gate: all_exceeded`:

- All eligible tokens are above their `quota_threshold`.
- Check token thresholds and provider usage/rate-limit APIs.
- Lookup failures are fail-open, so all-exceeded means qgrid got usable over-threshold signals.

`Direct LLM API fallback not implemented`:

- Model likely lacks `openai/` or `anthropic/` prefix.
- Do not silently route prefix-less Claude model names to Anthropic.

`No anthropic tokens available`:

- Anthropic token pool is empty.
- Check active Anthropic tokens, subscriber reconcile, and token provider values.

`Claude session closed without result`:

- Claude child exited without a result line.
- Check stderr suffix in the error, spawn args, OAuth token validity, `CLAUDE_CONFIG_DIR` isolation, and CLI version.

`error_max_structured_output_retries`:

- Claude Code structured output failed after retries.
- Treat as a real error, not a recoverable partial result.
- Check schema strictness and `stream-json-adapter` behavior.

`qgrid: imageGeneration is not supported with streamText`:

- Image generation is non-stream only. Use `generateText`.

`image generation is not supported on the Anthropic route`:

- Image generation is OpenAI/Codex-only.

`imageGeneration was requested but the response contained no image`:

- AI SDK version-skew guard. The client requested image generation, but the server returned text-only content. Check server version and the OpenAI image-generation path.

`reference image input is too large for JSON transport`:

- AI SDK reference-image guard. The client passed a base64 image data URL large enough to likely exceed qgrid's JSON request body transport. Compress or resize the image before calling `generateText`, preferably as WebP/JPEG.

OpenAI `ImageGenerationError` kinds:

- `gate`: capability/model check failed before the turn.
- `not_called`: model completed but did not call Codex `image_generation`.
- `incomplete`: image tool was attempted but no completed base64 image was produced.

`worker not ready`:

- OpenAI Codex worker RPC is missing or not initialized.
- Check worker spawn/login failures and restart logs.

`OpenAI refresh failed`:

- Inspect response body for refresh token death codes.
- If refresh token rotated but DB save failed, treat the token as at risk and require re-registration.

`re-login required`:

- Anthropic usage refresh failed and qgrid could not recover with stored refresh token.

## Debugging Rules

- Start from the package-specific tests before running smoke scripts.
- For provider issues, identify route by model prefix first.
- For cache issues, inspect `threadCoord`, `systemHash`, provider route, and usage semantics before assuming provider cache failure.
- For dashboard metric issues, verify qgrid-standard usage fields before changing UI formulas.
- For Sonamu shape changes, verify API generated files and web consumers together.
