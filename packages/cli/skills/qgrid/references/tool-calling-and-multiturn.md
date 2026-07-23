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

Do not describe this as OpenAI native function calling, Claude native tool use, or Codex/Claude executing client tools. The tools are client-side AI SDK tools requested through structured-output emulation.

## Client Flow

`packages/ai-sdk/src/index.ts` implements AI SDK `LanguageModelV3`.

When `options.tools` contains function tools:

1. Filter function tools.
2. Convert them with `toQgridTool`.
3. Send `tools` in `/api/qgrid/query` or `/api/qgrid/prepareStream`.
4. Forward the per-call `logger` switch when request logging is disabled.
5. Do not send `jsonSchema` response format at the same time. The server infers whether the logged request becomes a multi-step run.

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

`packages/api/src/application/qgrid/tool-emulation.ts` builds the tool-call schema.

The schema shape is:

```json
{
  "action": "answer | tool_call",
  "answer": "string | null",
  "toolCalls": [
    {
      "toolName": "one of the AI SDK tool names",
      "args": "JSON string"
    }
  ]
}
```

The schema explicitly tells the model:

- use `tool_call` when client-side tool execution is needed;
- use `answer` only for a final answer;
- do not invoke listed tools as native Claude Code tools;
- put tool arguments in `args` as a JSON string.

`qgrid.dispatcher.ts` strictifies this schema through `buildStrictOutputSchema` before it reaches provider dispatchers.

If tools and `jsonSchema` are both present, dispatcher rejects the request.

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

`applyToolCallEmulation` handles provider text:

- No tools: return normal text content.
- Tools present and JSON parse fails: warn and fall back to text with `finishReason: "stop"`.
- `action: "tool_call"`: validate tool names, generate qgrid `toolCallId`, return `finishReason: "tool-calls"`.
- `action: "answer"`: return final text with `finishReason: "stop"`.

Unknown tool names throw.

## Multi-Step And Multi-Turn

AI SDK multi-step behavior is client-orchestrated:

1. qgrid returns emulated tool calls.
2. AI SDK executes tools locally.
3. AI SDK calls qgrid again with tool results.
4. qgrid asks the model to continue from those results.

This is different from a provider-native tool loop. Neither Codex nor Claude Code executes the AI SDK tool functions.

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
