# Request Log Run Lifecycle

Use this reference when changing request logging, tool-call loop logging, telemetry logger integration, request log steps, or dashboard metrics.

## Modes

qgrid query supports `logMode`:

- `auto`: save one request_log after a simple request succeeds.
- `run`: create/update a run and append steps for multi-step/tool-call flows.
- `none`: no automatic logging.

If `logMode` is omitted, `qgrid.frame.ts` uses `run` when `isStep` is true and `auto` otherwise.

## Query flow

For `logMode: "run"`:

1. `beforeQuery(args)` creates or extends a run.
2. `QgridDispatcher.query` or `queryStream` executes the provider call.
3. `afterQuery(...)` records result/step data and returns `runContext`.
4. qgrid merges lifecycle `requestLogId` with provider `threadCoord`.
5. Errors call `finishRunWithError`; stream close can call abort handling.

For `auto`:

- qgrid saves a single request log row after the provider returns.
- It records token name, project name, model, prompts, response, usage, duration, TTFT, driver cost, image cost estimate, effort, history, status, tool-call count, and image-generation flag.
- Image results are also appended as synthetic `image_generation` tool-call steps so the detail page can inspect the generated image and pricing assumption.

## Tool-call loop

The AI SDK provider tracks pending tool-call IDs. When the next AI SDK call contains all required tool results, it sends:

- existing `runContext`
- `toolResults`
- `logMode: "run"`

qgrid converts tool results into continuation input for providers. Cold fallback still includes a "continue using these results" text input.

Tool calls are produced through qgrid structured-output emulation, not native provider tool calling. The request log lifecycle records the emulated generate step, pending tool-call step rows, tool results on follow-up, and the final generate step. For full semantics, read `tool-calling-and-multiturn.md`.

## Usage fields

Stored request log usage uses qgrid-standard semantics:

- `input_tokens`: total input, including cache read/write.
- `cache_read_tokens`: cached input read.
- `cache_creation_tokens`: prompt cache write input.
- `output_tokens`: output tokens.
- `cost_usd`: integer micro-USD in DB; displayed USD is `cost_usd / 1_000_000`.
- `image_cost_usd`: integer micro-USD estimate for Codex image generation output.
- `image_cost_method`: string such as `assumed:gpt-image-2:medium:1536x1024:png`.

OpenAI/Codex: use per-turn `.last` usage from `thread/tokenUsage/updated`.

Anthropic: normalize native mutually exclusive categories by summing input + cache creation + cache read into total input.

For image requests, keep `cost_usd` as the Codex driver model token cost. Image output cost is separate because qgrid observes Codex's `image_generation` result, not the OpenAI Images API usage object. Treat `image_cost_usd` as a price-table estimate that may be inaccurate if Codex changes its underlying image accounting.

Reference images for image generation are not stored in `request_logs.user_prompt`; that field remains the text prompt. For inspection in the detail view, qgrid stores reference image metadata/base64 in the synthetic `image_generation` step's `tool_args.inputImages`. If Codex returns multiple image outputs, store `inputImages` only on the first synthetic image tool step so multi-output logs do not duplicate the same input payload on every output.

## Legacy normalization

`RequestLogModel` normalizes legacy Anthropic rows where stored `input_tokens` may not include cache read/write. Keep this in mind when changing cost or display logic.

## TTFT

TTFT is tracked by wrapping first provider delta:

- OpenAI: first `item/agentMessage/delta`.
- Anthropic: first text or structured partial JSON delta.

If missing, qgrid maps TTFT to `0` in `QueryOutput` and nullable/optional places as appropriate.

## Logger integration

`packages/ai-sdk/src/logger.ts` lets non-qgrid providers write logs into qgrid. It skips model provider `qgrid` to avoid double logging. Preserve stale-run cleanup because AI SDK telemetry may emit start without a final event on provider failures.
