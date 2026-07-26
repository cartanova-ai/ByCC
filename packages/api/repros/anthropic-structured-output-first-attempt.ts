/**
 * Verify qgrid returns Claude Code's final successful structured_output after an
 * internally rejected StructuredOutput attempt.
 *
 * This is deterministic and does not call Claude or consume subscription quota:
 *
 *   pnpm exec tsx packages/api/repros/anthropic-structured-output-first-attempt.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  type ClaudeStreamJsonState,
  handleStreamJsonLine,
} from "../src/utils/providers/anthropic/stream-json-adapter";

const finalOutput = {
  title: "정상 제목",
  opening_line: "두 번째 시도에서 스키마를 만족한 최종 응답",
};

const failedAttempts = [
  {
    name: "__unparsedToolInput",
    input: {
      __unparsedToolInput: {
        raw: '{"title":"파싱 도중 잘린 제목","opening_line":"불완전한 JSON',
      },
    },
  },
  {
    name: "$PARAMETER_NAME",
    input: {
      $PARAMETER_NAME: JSON.stringify(finalOutput),
    },
  },
  {
    name: "paramName",
    input: {
      paramName: JSON.stringify(finalOutput),
    },
  },
  {
    name: "jsonPayload",
    input: {
      jsonPayload: JSON.stringify(finalOutput),
    },
  },
  {
    name: "value",
    input: {
      value: JSON.stringify(finalOutput),
    },
  },
] as const;

function assistantStructuredOutput(input: unknown): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", name: "StructuredOutput", input }],
    },
  });
}

function structuredOutputResult(isError: boolean, content: string): string {
  return JSON.stringify({
    type: "user",
    message: {
      content: [{ type: "tool_result", is_error: isError, content }],
    },
  });
}

function objectKeys(value: unknown): string[] {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.keys(value)
    : [];
}

function reproduce(firstRejectedInput: unknown): {
  returned: unknown;
  isError: boolean;
  subtype: string | undefined;
} {
  const state: ClaudeStreamJsonState = {};
  const lines = [
    assistantStructuredOutput(firstRejectedInput),
    structuredOutputResult(true, "Output does not match required schema"),
    assistantStructuredOutput(finalOutput),
    structuredOutputResult(false, "Structured output provided successfully"),
    JSON.stringify({
      type: "result",
      subtype: "success",
      terminal_reason: "completed",
      structured_output: finalOutput,
      usage: { input_tokens: 20, output_tokens: 10 },
    }),
  ];

  let result: ReturnType<typeof handleStreamJsonLine> = null;
  for (const line of lines) {
    result =
      handleStreamJsonLine(line, () => undefined, {
        structuredOutput: true,
        state,
      }) ?? result;
  }

  assert.ok(result, "Claude result event must produce a qgrid result");
  return {
    returned: JSON.parse(result.text) as unknown,
    isError: result.isError,
    subtype: result.subtype,
  };
}

function replayRawCapture(path: string): void {
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const state: ClaudeStreamJsonState = {};
  const attempts: unknown[] = [];
  let finalStructuredOutput: unknown;
  let result: ReturnType<typeof handleStreamJsonLine> = null;

  for (const line of lines) {
    const event = JSON.parse(line) as {
      type?: string;
      message?: { content?: Array<{ type?: string; name?: string; input?: unknown }> };
      structured_output?: unknown;
    };
    if (event.type === "assistant") {
      for (const part of event.message?.content ?? []) {
        if (part.type === "tool_use" && part.name === "StructuredOutput") {
          attempts.push(part.input);
        }
      }
    }
    if (event.type === "result") finalStructuredOutput = event.structured_output;

    result =
      handleStreamJsonLine(line, () => undefined, {
        structuredOutput: true,
        state,
      }) ?? result;
  }

  assert.ok(result, "capture must contain a Claude result event");
  assert.ok(attempts.length > 1, "capture must contain a rejected attempt and a retry");
  assert.notDeepEqual(attempts[0], finalStructuredOutput, "first attempt must differ from final");
  assert.deepEqual(attempts.at(-1), finalStructuredOutput, "last attempt must equal final");

  const returned = JSON.parse(result.text) as unknown;
  assert.notDeepEqual(returned, attempts[0], "qgrid must not return the first rejected input");
  assert.deepEqual(
    returned,
    finalStructuredOutput,
    "qgrid must return the final successful output",
  );

  console.log(`[LIVE FIX VERIFIED] ${path}`);
  console.log(`  StructuredOutput attempts: ${attempts.length}`);
  console.log(`  first keys: ${JSON.stringify(objectKeys(attempts[0]))}`);
  console.log(`  final keys: ${JSON.stringify(objectKeys(finalStructuredOutput))}`);
  console.log(
    `  qgrid returned first: ${JSON.stringify(returned) === JSON.stringify(attempts[0])}`,
  );
  console.log(
    `  qgrid returned final: ${JSON.stringify(returned) === JSON.stringify(finalStructuredOutput)}`,
  );
}

const capturePath = process.argv[2];
if (capturePath) {
  replayRawCapture(capturePath);
  process.exit(0);
}

console.log("Claude result: second StructuredOutput accepted, subtype=success");
console.log("Expected qgrid output:", JSON.stringify(finalOutput));
console.log("");

for (const failedAttempt of failedAttempts) {
  const actual = reproduce(failedAttempt.input);

  assert.equal(actual.subtype, "success");
  assert.equal(actual.isError, false);
  assert.notDeepEqual(
    actual.returned,
    failedAttempt.input,
    `${failedAttempt.name}: qgrid returned the first rejected input`,
  );
  assert.deepEqual(
    actual.returned,
    finalOutput,
    `${failedAttempt.name}: qgrid did not return the final successful output`,
  );

  console.log(`[FIX VERIFIED] ${failedAttempt.name}`);
  console.log("  returned:", JSON.stringify(actual.returned));
}
