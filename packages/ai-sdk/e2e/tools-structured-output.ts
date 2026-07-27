/**
 * Public AI SDK acceptance: tools + Output.object
 *
 * Exercises a real qgrid server through qgrid(), generateText(), and
 * streamText() for both provider routes. This consumes provider quota and is
 * intentionally separate from the existing e2e suite.
 *
 * Usage:
 *   QGRID_REAL_PROVIDER_ACCEPTANCE=1 \
 *   pnpm --filter @cartanova/qgrid-ai-sdk e2e:tools-output
 *
 * Optional:
 *   QGRID_URL=http://localhost:44900
 *   QGRID_ACCEPTANCE_OPENAI_MODEL=openai/gpt-5.6-terra
 *   QGRID_ACCEPTANCE_ANTHROPIC_MODEL=anthropic/claude-sonnet-4-6
 *   QGRID_ACCEPTANCE_OPENAI_DIRECT_REPEATS_PER_MODE=10
 *   QGRID_ACCEPTANCE_PROVIDER=openai|anthropic|all
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { generateText, Output, stepCountIs, streamText, tool } from "ai";
import { z } from "zod";

import { qgrid } from "../src/index";

const OPT_IN_ENV = "QGRID_REAL_PROVIDER_ACCEPTANCE";
const SERVER_URL = process.env.QGRID_URL ?? "http://localhost:44900";
const PROJECT_NAME = "qgrid-ai-sdk-tools-output-acceptance";
const TOOL_NAME = "lookupAcceptanceMarker";
const TOOL_REQUEST_ID = "qgrid-acceptance-request";
const STOP_WHEN = stepCountIs(3);
const OPENAI_DIRECT_REPEATS_PER_MODE = positiveIntegerEnv(
  "QGRID_ACCEPTANCE_OPENAI_DIRECT_REPEATS_PER_MODE",
  10,
);

type QgridModel = Parameters<typeof qgrid>[0];
type ProviderCase = {
  name: "openai" | "anthropic";
  model: QgridModel;
};
type Mode = "generateText" | "streamText";
type StepLike = {
  toolCalls: ReadonlyArray<{ toolName: string }>;
};
type DirectCase<T extends DirectOutput> = {
  expected: T;
  schema: z.ZodType<T>;
  instruction: string;
};

type OpenAIDirectOutput = z.infer<typeof openAIDirectOutputSchema>;
type AnthropicDirectOutput = z.infer<typeof anthropicDirectOutputSchema>;
type DirectOutput = OpenAIDirectOutput | AnthropicDirectOutput;
type ToolOutput = z.infer<typeof toolOutputSchema>;

const OPENAI_DIRECT_OUTPUT: OpenAIDirectOutput = {
  kind: "direct-final",
  message: "DIRECT_OUTPUT_OK",
  sequence: 7,
  tuple: [{ label: "TUPLE_OK" }, 11],
};

const ANTHROPIC_DIRECT_OUTPUT: AnthropicDirectOutput = {
  kind: "direct-final",
  message: "DIRECT_OUTPUT_OK",
  sequence: 7,
  details: { label: "ANTHROPIC_OK" },
};

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  assert.ok(Number.isSafeInteger(value) && value > 0, `${name} must be a positive integer`);
  return value;
}

const openAIDirectOutputSchema = z.object({
  kind: z.literal("direct-final"),
  message: z.literal("DIRECT_OUTPUT_OK"),
  sequence: z.literal(7),
  tuple: z.tuple([z.object({ label: z.literal("TUPLE_OK") }), z.literal(11)]),
});

const anthropicDirectOutputSchema = z.object({
  kind: z.literal("direct-final"),
  message: z.literal("DIRECT_OUTPUT_OK"),
  sequence: z.literal(7),
  details: z.object({ label: z.literal("ANTHROPIC_OK") }),
});

const toolOutputSchema = z.object({
  kind: z.literal("tool-follow-up"),
  requestId: z.literal(TOOL_REQUEST_ID),
  marker: z.string(),
  checksum: z.number().int(),
});

function configuredModel(
  envName: string,
  fallback: QgridModel,
  providerPrefix: `${ProviderCase["name"]}/`,
): QgridModel {
  const model = (process.env[envName] ?? fallback) as QgridModel;
  assert.ok(
    model.startsWith(providerPrefix),
    `${envName} must start with "${providerPrefix}", received "${model}"`,
  );
  return model;
}

const ALL_PROVIDERS: ProviderCase[] = [
  {
    name: "openai",
    model: configuredModel(
      "QGRID_ACCEPTANCE_OPENAI_MODEL",
      "openai/gpt-5.6-terra",
      "openai/",
    ),
  },
  {
    name: "anthropic",
    model: configuredModel(
      "QGRID_ACCEPTANCE_ANTHROPIC_MODEL",
      "anthropic/claude-sonnet-4-6",
      "anthropic/",
    ),
  },
];

const providerFilter = process.env.QGRID_ACCEPTANCE_PROVIDER ?? "all";
assert.ok(
  providerFilter === "all" || providerFilter === "openai" || providerFilter === "anthropic",
  "QGRID_ACCEPTANCE_PROVIDER must be openai, anthropic, or all",
);
const PROVIDERS = ALL_PROVIDERS.filter(
  ({ name }) => providerFilter === "all" || name === providerFilter,
);

function modelFor(provider: ProviderCase) {
  return qgrid(provider.model, {
    serverUrl: SERVER_URL,
    projectName: PROJECT_NAME,
    defaultEffort: "low",
  });
}

function assertDirectResult(
  output: DirectOutput,
  expected: DirectOutput,
  steps: ReadonlyArray<StepLike>,
  finishReason: string,
  toolExecutions: number,
) {
  assert.deepStrictEqual(output, expected);
  assert.equal(finishReason, "stop");
  assert.equal(toolExecutions, 0, "the direct-final case unexpectedly executed a tool");
  assert.deepStrictEqual(
    steps.map((step) => step.toolCalls.map((call) => call.toolName)),
    [[]],
    "the direct-final case must complete in one step without selecting a tool",
  );
}

function assertToolResult(
  output: ToolOutput,
  expected: ToolOutput,
  steps: ReadonlyArray<StepLike>,
  finishReason: string,
  toolExecutions: number,
) {
  assert.deepStrictEqual(output, expected);
  assert.equal(finishReason, "stop");
  assert.equal(toolExecutions, 1, "the follow-up case must execute the tool exactly once");
  assert.deepStrictEqual(
    steps.map((step) => step.toolCalls.map((call) => call.toolName)),
    [[TOOL_NAME], []],
    "the follow-up case must contain one tool-call step followed by one final-answer step",
  );
}

function assertStreamedOutput(streamedText: string, expected: DirectOutput | ToolOutput) {
  assert.notEqual(streamedText, "", "streamText did not emit the final JSON text");
  assert.deepStrictEqual(
    JSON.parse(streamedText),
    expected,
    "the streamed final JSON must match the parsed structured output",
  );
}

async function runDirectFinalCase<T extends DirectOutput>(
  provider: ProviderCase,
  mode: Mode,
  directCase: DirectCase<T>,
) {
  let toolExecutions = 0;
  const hiddenNonce = randomUUID();
  const tools = {
    [TOOL_NAME]: tool({
      description:
        "Look up a hidden acceptance marker. Do not use this tool unless the user explicitly requests a marker lookup.",
      inputSchema: z.object({ requestId: z.literal(TOOL_REQUEST_ID) }),
      execute: async () => {
        toolExecutions++;
        return { marker: "UNEXPECTED_TOOL_EXECUTION" };
      },
    }),
  };
  const request = {
    model: modelFor(provider),
    prompt: [
      "This is the direct-final control case.",
      "Do not call any tool.",
      `Do not return or mention this hidden test nonce: ${hiddenNonce}.`,
      directCase.instruction,
    ].join("\n"),
    tools,
    output: Output.object({ schema: directCase.schema }),
    stopWhen: STOP_WHEN,
    maxRetries: 0,
  } as const;

  if (mode === "generateText") {
    const result = await generateText(request);
    assertDirectResult(
      result.output,
      directCase.expected,
      result.steps,
      result.finishReason,
      toolExecutions,
    );
    return;
  }

  const result = streamText(request);
  let streamedText = "";
  for await (const chunk of result.textStream) {
    streamedText += chunk;
  }
  const output = await result.output;
  const steps = await result.steps;
  const finishReason = await result.finishReason;
  assertStreamedOutput(streamedText, directCase.expected);
  assertDirectResult(output, directCase.expected, steps, finishReason, toolExecutions);
}

async function runDirectFinal(provider: ProviderCase, mode: Mode) {
  if (provider.name === "openai") {
    return runDirectFinalCase(provider, mode, {
      expected: OPENAI_DIRECT_OUTPUT,
      schema: openAIDirectOutputSchema,
      instruction:
        'Return kind="direct-final", message="DIRECT_OUTPUT_OK", sequence=7, and tuple=[{"label":"TUPLE_OK"},11].',
    });
  }

  return runDirectFinalCase(provider, mode, {
    expected: ANTHROPIC_DIRECT_OUTPUT,
    schema: anthropicDirectOutputSchema,
    instruction:
      'Return kind="direct-final", message="DIRECT_OUTPUT_OK", sequence=7, and details={"label":"ANTHROPIC_OK"}.',
  });
}

async function runToolFollowUp(provider: ProviderCase, mode: Mode) {
  const expected: ToolOutput = {
    kind: "tool-follow-up",
    requestId: TOOL_REQUEST_ID,
    marker: `qgrid-e2e-${randomUUID()}`,
    checksum: 424_242,
  };
  let toolExecutions = 0;
  const tools = {
    [TOOL_NAME]: tool({
      description:
        "Return the hidden marker for the supplied acceptance request. Call exactly once when the user asks for the acceptance marker.",
      inputSchema: z.object({ requestId: z.literal(TOOL_REQUEST_ID) }),
      execute: async ({ requestId }) => {
        assert.equal(requestId, TOOL_REQUEST_ID);
        toolExecutions++;
        return {
          requestId,
          marker: expected.marker,
          checksum: expected.checksum,
        };
      },
    }),
  };
  const request = {
    model: modelFor(provider),
    prompt: [
      `Call ${TOOL_NAME} exactly once with requestId="${TOOL_REQUEST_ID}".`,
      "Do not guess or invent the hidden marker.",
      "After the tool result arrives, return kind, requestId, marker, and checksum from that result.",
    ].join("\n"),
    tools,
    output: Output.object({ schema: toolOutputSchema }),
    stopWhen: STOP_WHEN,
    maxRetries: 0,
  } as const;

  if (mode === "generateText") {
    const result = await generateText(request);
    assertToolResult(result.output, expected, result.steps, result.finishReason, toolExecutions);
    return;
  }

  const result = streamText(request);
  let streamedText = "";
  for await (const chunk of result.textStream) {
    streamedText += chunk;
  }
  const output = await result.output;
  const steps = await result.steps;
  const finishReason = await result.finishReason;
  assertStreamedOutput(streamedText, expected);
  assertToolResult(output, expected, steps, finishReason, toolExecutions);
}

let passed = 0;
let failed = 0;

async function acceptance(name: string, run: () => Promise<void>) {
  try {
    await run();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(error instanceof Error ? error.stack : error);
  }
}

async function main() {
  if (process.env[OPT_IN_ENV] !== "1") {
    console.error(
      [
        "Real-provider acceptance was not started because it consumes provider quota.",
        `Set ${OPT_IN_ENV}=1 to opt in explicitly.`,
      ].join("\n"),
    );
    process.exit(2);
  }

  console.log("\nqgrid tools + Output.object real-provider acceptance");
  console.log(`  server:  ${SERVER_URL}`);
  console.log(`  project: ${PROJECT_NAME}`);
  console.log(`  models:  ${PROVIDERS.map(({ model }) => model).join(", ")}\n`);

  for (const provider of PROVIDERS) {
    for (const mode of ["generateText", "streamText"] as const) {
      const directRepeats = provider.name === "openai" ? OPENAI_DIRECT_REPEATS_PER_MODE : 1;
      for (let attempt = 1; attempt <= directRepeats; attempt += 1) {
        await acceptance(
          `${provider.name} ${mode}: direct final ${attempt}/${directRepeats}`,
          () => runDirectFinal(provider, mode),
        );
      }
      await acceptance(`${provider.name} ${mode}: one tool then final`, () =>
        runToolFollowUp(provider, mode),
      );
    }
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("Acceptance failed:", error);
  process.exitCode = 1;
});
