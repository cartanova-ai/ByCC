# Tool Calling And Multi-Turn

Use this reference before changing qgrid tool calling, AI SDK multi-step behavior, tool-result follow-ups, or request-log tool steps.

## Contents

- High-level contract
- Client flow
- Server schema emulation
- Provider-specific path
- Applying emulated tool calls
- Multi-step and multi-turn
- Request logs

## High-Level Contract

qgrid supports the AI SDK `tools` interface, but it does not use native provider tool calling.

- Users write normal AI SDK code with `generateText`, `streamText`, `tools`, `stopWhen`, and related AI SDK APIs.
- The AI SDK owns client-side tool execution.
- qgrid owns LLM turns and request logging.
- qgrid turns AI SDK tools into a strict structured-output schema.
- The model emits a structured object describing either a final answer or requested client-side tool calls.
- qgrid maps that structured object back into AI SDK `tool-call` content.
- The AI SDK executes the actual tool functions and calls qgrid again with tool results.

`generateText` and `streamText` default to `stepCountIs(1)`. When an executable
tool can run before the final answer, callers must set a bounded `stopWhen`
(for example `stepCountIs(3)`) or the AI SDK stops after the first tool-call
step and cannot produce the final text or `Output.object` value.

Do not describe this as OpenAI native function calling, Claude native tool use, or Codex/Claude executing client tools. The tools are client-side AI SDK tools requested through structured-output emulation.

## Client Flow

`packages/ai-sdk/src/index.ts` implements AI SDK `LanguageModelV3`.

When `options.tools` contains function tools:

1. Filter function tools.
2. Convert them with `toQgridTool`.
3. Send `tools` in `/api/qgrid/query` or `/api/qgrid/prepareStream`.
4. Forward the per-call `logger` switch when request logging is disabled.
5. When a top-level object response format is present, send `jsonSchema` alongside
   `tools`. The server composes both schemas and infers whether the logged request
   becomes a multi-step run.

When qgrid responds with `finishReason: "tool-calls"`:

1. Map qgrid `content: [{ type: "tool-call" }]` to AI SDK tool-call content.
2. Store the pending tool-call IDs, local correlation state, and any returned `runContext` in the provider instance registry. Logging-enabled calls receive a request-log id; logging-disabled calls do not need one.
3. Return finish reason `{ unified: "tool-calls", raw: "tool_call" }`.

On the next AI SDK call, if prompt history contains tool results for all pending IDs:

1. Extract tool results from AI SDK history.
2. Match result IDs against the pending run registry.
3. Send the matched run's previous `runContext` when the server returned one.
4. Send `toolResults`.
5. Keep the call's `logger` setting. The server decides from the context and finish reason whether the request-log parent remains open.

If tool results do not match any pending run, qgrid warns and sends the request without stale `runContext`.
The registry is keyed per pending run so concurrent `generateText(...tools...)` calls on the same qgrid model instance can finish in any order.

## Server Schema Emulation

`packages/api/src/application/qgrid/tool-emulation-schema.ts` builds the tool-call schema.
`tool-emulation.ts` decodes the model's action envelope into qgrid answer/tool-call content.

The envelope is a root object with a `result` property holding a discriminated
union. The union makes degenerate combinations grammatically impossible: the
answer variant requires a non-null `answer` with `toolCalls: null`, and the
tool_call variant requires `answer: null` with at least one tool call. The union
nests under `result` because OpenAI structured outputs requires an object root
and rejects a top-level `anyOf` (nested `anyOf` and `minItems` are supported;
verified against both providers on 2026-07-30).

```jsonc
{
  "type": "object",
  "properties": {
    "result": {
      "anyOf": [
        { "action": "answer", "answer": "string (or user schema $ref)", "toolCalls": null },
        { "action": "tool_call", "answer": null, "toolCalls": [{ "toolName": "…", "args": "JSON string" }] } // minItems 1
      ]
    }
  },
  "required": ["result"]
}
```

The flat pre-2.5.7 envelope allowed `action:"answer", answer:null` through
constrained decoding; the tolerant decoder then leaked the raw envelope as the
final answer text (measured 13.5k corrupted medpath rows, 2026-07-03..15). That
incident is why both the schema and the decoder are strict now.

The schema explicitly tells the model:

- use `tool_call` when client-side tool execution is needed;
- use `answer` only for a final answer;
- do not invoke listed tools as native Claude Code tools;
- put tool arguments in `args` as a JSON string.

`qgrid.dispatcher.ts` strictifies this schema through `buildStrictOutputSchema` before it reaches provider dispatchers.

## Composing Tools With A User Output Schema

This section explains why `tool-emulation-schema.ts` exists at all. Read it
before changing schema composition; the mechanics look arbitrary without the
failure it was built to prevent.

### The problem

AI SDK hands the provider `tools` and `responseFormat` independently on every
step, and gives no "this is the final turn" flag. Before 2.5.4, qgrid saw tools
and dropped the user schema, so `answer` stayed a free-form string:

```json
{ "action": "answer", "answer": "string | null", "toolCalls": "…" }
```

`strict: true` was in force, but only over that outer envelope. A model could
therefore return valid JSON with trailing garbage and still satisfy the schema:

```jsonc
// Envelope-valid. answer is a string, so the trailing marker is legal.
{ "action": "answer", "answer": "{\"title\":\"...\"}<|proto_end|>", "toolCalls": null }
```

Measured on the Medpath `translateBatch()` path: 5 of 10 raw Terra responses
were corrupted this way, while the same workload with a schema and no tools
failed 0 of 385 times. The model was fine; nothing constrained the final answer.

### The fix, and why it needs rebasing

Embed the user schema in the `answer` branch so the provider's
constrained-output machinery enforces it — the same machinery that scored
385/385. The model still chooses `tool_call` to continue the loop or `answer` to
finish, and qgrid never adds an extra turn to "finalize".

Embedding cannot be a verbatim nest, because `$ref` is document-absolute. `#`
means the root of the *final* document, not the root of the fragment it was
written in. Nest a caller schema unchanged and its pointers silently retarget
the envelope:

```jsonc
// Caller sends this. "#/$defs/Person" resolves inside their own document.
{
  "type": "object",
  "properties": { "author": { "$ref": "#/$defs/Person" } },
  "$defs": { "Person": { "type": "object", "properties": { "name": { "type": "string" } } } }
}
```

Nested verbatim, `#/$defs/Person` now points at the envelope root, where no
`Person` exists — a broken reference, or worse, a coincidental match against an
unrelated definition. Validation would then check the wrong shape and say
nothing.

So composition does two things: park the caller schema under a reserved name,
and rewrite every local pointer to the new base.

```jsonc
{
  "type": "object",
  "properties": {
    "result": { "anyOf": [
      // answer variant: string slot becomes a reference to the caller's schema
      { "properties": { "action": { "enum": ["answer"] }, "answer": { "$ref": "#/$defs/__qgrid_user_output" }, "toolCalls": { "type": "null" } } },
      { "…": "tool_call variant unchanged" }
    ] }
  },
  "$defs": {
    "__qgrid_user_output": {
      "type": "object",
      "properties": { "author": { "$ref": "#/$defs/__qgrid_user_output/$defs/Person" } },
      "$defs": { "Person": { "type": "object", "properties": { "name": { "type": "string" } } } }
    }
  }
}
```

Pointer rewriting is mechanical — `#` gains the namespace prefix:

| Caller writes | Becomes |
| --- | --- |
| `#` | `#/$defs/__qgrid_user_output` |
| `#/$defs/Person` | `#/$defs/__qgrid_user_output/$defs/Person` |

### Why the traversal is exhaustive

A missed position means an un-rebased `$ref` shipping to the provider, so the
rewriter must visit every place a subschema can hide. JSON Schema puts them in
three shapes — name→schema maps (`properties`, `$defs`), schema arrays
(`anyOf`, `prefixItems`), and single slots (`items`, `not`, `if`) — plus Draft-7
`dependencies`, whose value is either a schema or a list of property names.

That position list is shared: `utils/providers/common/json-schema-keywords.ts`
owns it, and the rebaser, the normalization scan, and the strict rewrite all
read from it. They previously kept private copies and had already drifted
(`additionalItems` was rebased but not scanned). Add a new keyword there, not in
a consumer.

Consumers still differ in what they *do* per position, and that stays local: the
strictifier marks positions like `not` and `if` non-normalizable because
tightening them would change caller semantics.

### What is rejected, and why silence is not an option

Composition fails loudly on `$id`, `id`, `$anchor`, `$dynamicAnchor`,
`$recursiveAnchor`, `$dynamicRef`, and `$recursiveRef`. Each one breaks the
premise that a pointer's meaning survives relocation: `$id` declares a new base
URI so descendant refs stop resolving against the document root, and dynamic
refs pick their target from runtime scope. There is no correct rewrite, and a
wrong one would validate the wrong shape without complaint — so callers get an
HTTP 400 naming the offending path instead.

Non-object top-level schemas are also rejected. Only `type: "object"` roots can
occupy the `answer` branch.

### Compatibility

The answer variant's `answer` slot falls back to `{ "type": "string" }` whenever
no user schema is present, and the decoder returns that string verbatim (no JSON
quoting). The public `QueryOutput` contract is unchanged for well-formed model
output, so SDK versions are unaffected; only the server-internal envelope shape
changed in 2.5.7 (`result` wrapper), which resets provider prompt-cache prefixes
once per deploy.

## Provider-Specific Path

OpenAI/Codex:

- qgrid does not register AI SDK tools as Codex native tools.
- Codex built-in tools are disabled in worker config.
- qgrid sends the strict tool-call schema as `outputSchema` in `turn/start`.
- Codex returns text matching the structured schema.
- qgrid parses that text and maps it to qgrid `tool-call` content.

Anthropic/Claude Code:

- qgrid does not allow client tools as Claude Code native tools.
- Claude is spawned with `--tools ""`.
- When a schema exists, qgrid permits only `StructuredOutput` with `--allowed-tools StructuredOutput`.
- qgrid passes the strict tool-call schema through `--json-schema`.
- The stream adapter preserves `StructuredOutput` tool input as final structured text.
- qgrid parses that text and maps it to qgrid `tool-call` content.

In both providers, native provider tools are not the public abstraction. The public abstraction is AI SDK tools plus qgrid structured-output emulation.

## Applying Emulated Tool Calls

`applyToolCallEmulation` handles provider text with a single strict decoder.
There is no tolerant mode: any malformed, degenerate, or non-JSON envelope on a
tools request raises `ToolCallEmulationError` instead of being rescued as text.
The old tolerant decoder silently shipped degenerate envelopes as answers
(13.5k medpath rows, 2026-07); rescue is strictly worse than failing loudly.

- No tools: return normal text content (no envelope involved).
- `action: "tool_call"`: validate tool names, generate qgrid `toolCallId`, return `finishReason: "tool-calls"`.
- `action: "answer"` with `answerKind: "text"` (tools-only): return the string answer verbatim as final text.
- `action: "answer"` with `answerKind: "json"` (tools + user schema): JSON-serialize the
  `answer` as final text so AI SDK can parse and validate `Output.object`.

Unknown tool names throw. `answerKind` is required and derived from
`input.jsonSchema` presence at the dispatcher.

## Streaming With Tools (Envelope Delta Re-Emission)

With tools, provider deltas are raw envelope JSON. The server forwards them
unmodified over SSE. The SDK (`envelope-stream-parser.ts`, wired into
`doStream`) incrementally parses that envelope and re-emits only the
`result.answer` value as `text-delta` parts once `result.action` resolves to
`"answer"` (SON-527, SDK-only change — the server was never the blocker).

- Undetermined or `tool_call` envelopes emit nothing, matching the pre-change
  hold-everything behavior.
- `answerKind: "text"`: the answer JSON string is unescaped to plain text;
  escape sequences split across delta boundaries are safe (char-level state
  machine).
- `answerKind: "json"`: the answer value's raw JSON text is emitted verbatim so
  AI SDK `partialOutputStream` can partial-parse it.
- The parser is preview-only. The server strict decoder still decides the final
  result, and the `done` event's full-text fallback covers streams where the
  parser emitted nothing (`deltaTextEmitted` flag).
- Do not re-add a client-side gate that drops deltas when tools are present;
  that was the failure this section replaces.

## Multi-Step And Multi-Turn

AI SDK multi-step behavior is client-orchestrated:

1. qgrid returns emulated tool calls.
2. AI SDK executes tools locally.
3. AI SDK calls qgrid again with tool results.
4. qgrid asks the model to continue from those results.

This is different from a provider-native tool loop. Neither Codex nor Claude Code executes the AI SDK tool functions.

The composed schema is reapplied to tool-result follow-up turns. Final output is
identified by `action: "answer"` rather than by whether a tool happened to be
available or called. AI SDK `toolChoice` is not transported or enforced by
qgrid; the model selects between the envelope's answer and tool-call actions.

The combined contract requires qgrid server 2.5.4 and
`@cartanova/qgrid-ai-sdk` 2.5.4.

OpenAI/Codex follow-ups can reuse the same Codex thread when `runContext.threadCoord` remains valid. For tool-result follow-up turns, qgrid sends delta input containing tool result text to the existing thread; cold fallback injects full history.

Anthropic follow-ups do not reuse Claude sessions. qgrid starts a fresh Claude process, replays flattened full history, and sends the tool-result continuation input.

## Request Logs

Request logging defaults to enabled, and the server infers the tool-run lifecycle rather than accepting a caller-selected mode.

- `beforeQuery` creates or continues a request log run.
- A generate step is recorded after every LLM turn.
- When `finishReason` is `tool-calls`, qgrid appends pending tool-call step rows.
- The follow-up request fills tool-call results or errors.
- The final `stop` response aggregates step usage and finishes the run.
- Stale runs with unresolved tool-call steps are marked error after 30 minutes; long provider calls without pending tools are not swept solely for being `running`.
- `providerOptions.qgrid.logger: false` creates no parent or step rows, while the SDK still executes tools and correlates follow-ups locally.

Use `projectName` for tool-heavy workloads so request logs can be filtered by task/workflow and metrics remain interpretable.
