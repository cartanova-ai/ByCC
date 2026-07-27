import { Buffer } from "node:buffer";

import { describe, expect, it, vi } from "vitest";

import {
  ANTHROPIC_SCHEMA_ARGV_MAX_UTF8_BYTES,
  CALLER_SCHEMA_LIMITS,
  CallerSchemaValidationError,
  parseAndValidateCallerSchemas,
  serializeAndValidateDispatchSchema,
} from "./schema-validation";

// jsonSchema 단독 경로용 테스트 헬퍼 — 프로덕션 진입점은 parseAndValidateCallerSchemas 하나다.
const parseCallerOutputSchema = (jsonSchema: string) =>
  parseAndValidateCallerSchemas({ jsonSchema });

function schemaWithArrayDepth(arrayDepth: number): string {
  return `{"type":"object","x":${"[".repeat(arrayDepth)}0${"]".repeat(arrayDepth)}}`;
}

function schemaWithNodeCount(nodeCount: number): string {
  // root object + "object" string + enum array account for the other three nodes.
  const enumLength = nodeCount - 3;
  return `{"type":"object","enum":[${Array.from({ length: enumLength }, () => "0").join(",")}]}`;
}

function schemaWithUtf8Bytes(byteLength: number): string {
  const prefix = '{"type":"object","description":"';
  const suffix = '"}';
  const paddingLength =
    byteLength - Buffer.byteLength(prefix, "utf8") - Buffer.byteLength(suffix, "utf8");
  if (paddingLength < 0) throw new Error("requested schema byte length is too small");
  return `${prefix}${"x".repeat(paddingLength)}${suffix}`;
}

describe("caller schema validation", () => {
  it("accepts schemas exactly at each complexity boundary", () => {
    expect(() =>
      parseCallerOutputSchema(
        schemaWithUtf8Bytes(CALLER_SCHEMA_LIMITS.maxUtf8Bytes),
      ),
    ).not.toThrow();
    expect(() =>
      parseCallerOutputSchema(
        schemaWithNodeCount(CALLER_SCHEMA_LIMITS.maxNodes),
      ),
    ).not.toThrow();
    // Root is depth 0 and the primitive inside N nested arrays is depth N + 1.
    expect(() =>
      parseCallerOutputSchema(
        schemaWithArrayDepth(CALLER_SCHEMA_LIMITS.maxDepth - 1),
      ),
    ).not.toThrow();
  });

  it.each([
    [
      "UTF-8 bytes",
      () => schemaWithUtf8Bytes(CALLER_SCHEMA_LIMITS.maxUtf8Bytes + 1),
      "UTF-8 byte limit",
    ],
    [
      "nodes",
      () => schemaWithNodeCount(CALLER_SCHEMA_LIMITS.maxNodes + 1),
      "node limit",
    ],
    [
      "depth",
      () => schemaWithArrayDepth(CALLER_SCHEMA_LIMITS.maxDepth),
      "depth limit",
    ],
  ])("rejects schemas above the %s budget", (_label, makeSchema, message) => {
    expect(() => parseCallerOutputSchema(makeSchema())).toThrow(
      CallerSchemaValidationError,
    );
    expect(() => parseCallerOutputSchema(makeSchema())).toThrow(message);
  });

  it("measures the raw schema in UTF-8 bytes, not JavaScript code units", () => {
    const prefix = '{"type":"object","description":"';
    const suffix = '"}';
    const remainingBytes =
      CALLER_SCHEMA_LIMITS.maxUtf8Bytes -
      Buffer.byteLength(prefix, "utf8") -
      Buffer.byteLength(suffix, "utf8");
    const schema = `${prefix}${"가".repeat(Math.floor(remainingBytes / 3) + 1)}${suffix}`;

    expect(schema.length).toBeLessThan(CALLER_SCHEMA_LIMITS.maxUtf8Bytes);
    expect(() => parseCallerOutputSchema(schema)).toThrow(/UTF-8 byte limit/);
  });

  it("enforces the final Anthropic argv limit without constraining OpenAI to it", () => {
    const atLimit = JSON.parse(
      schemaWithUtf8Bytes(ANTHROPIC_SCHEMA_ARGV_MAX_UTF8_BYTES),
    );
    const aboveLimit = JSON.parse(
      schemaWithUtf8Bytes(ANTHROPIC_SCHEMA_ARGV_MAX_UTF8_BYTES + 1),
    );

    expect(() => serializeAndValidateDispatchSchema(atLimit, "anthropic")).not.toThrow();
    expect(() => serializeAndValidateDispatchSchema(aboveLimit, "anthropic")).toThrow(
      "Anthropic dispatch schema exceeds argv UTF-8 byte limit",
    );
    expect(() => serializeAndValidateDispatchSchema(aboveLimit, "openai")).not.toThrow();
  });

  it("enforces the aggregate limit again after schema composition", () => {
    const overLimit = {
      type: "object",
      description: "x".repeat(CALLER_SCHEMA_LIMITS.maxUtf8Bytes),
    } as const;

    expect(() => serializeAndValidateDispatchSchema(overLimit, "openai")).toThrow(
      "dispatch schema exceeds UTF-8 byte limit",
    );
  });

  it("rejects non-serializable direct dispatch schemas", () => {
    expect(() => serializeAndValidateDispatchSchema(() => {}, "anthropic")).toThrow(
      "dispatch schema must be JSON-serializable",
    );
  });

  it("applies the same depth guard to tools-only input schemas", () => {
    const inputSchema = JSON.parse(
      schemaWithArrayDepth(CALLER_SCHEMA_LIMITS.maxDepth),
    ) as unknown;

    expect(() =>
      parseAndValidateCallerSchemas({
        tools: [{ name: "deepTool", inputSchema }],
      }),
    ).toThrow(CallerSchemaValidationError);
    expect(() =>
      parseAndValidateCallerSchemas({
        tools: [{ name: "deepTool", inputSchema }],
      }),
    ).toThrow("tools[0].inputSchema exceeds depth limit");
  });

  it("aggregates node and byte budgets across output and tool schemas", () => {
    const halfNodeSchema = JSON.parse(
      schemaWithNodeCount(Math.floor(CALLER_SCHEMA_LIMITS.maxNodes / 2) + 1),
    ) as unknown;
    expect(() =>
      parseAndValidateCallerSchemas({
        tools: [
          { name: "first", inputSchema: halfNodeSchema },
          { name: "second", inputSchema: halfNodeSchema },
        ],
      }),
    ).toThrow("caller schemas exceed aggregate node limit");

    const halfByteSchema = JSON.parse(
      schemaWithUtf8Bytes(Math.floor(CALLER_SCHEMA_LIMITS.maxUtf8Bytes / 2) + 1),
    ) as unknown;
    expect(() =>
      parseAndValidateCallerSchemas({
        tools: [
          { name: "first", inputSchema: halfByteSchema },
          { name: "second", inputSchema: halfByteSchema },
        ],
      }),
    ).toThrow("caller schemas exceed aggregate UTF-8 byte limit");
  });

  it("counts a tool name twice before materializing the composed schema", () => {
    const name = "x".repeat(Math.floor(CALLER_SCHEMA_LIMITS.maxUtf8Bytes / 2));
    const stringify = vi.spyOn(JSON, "stringify");

    expect(Buffer.byteLength(name, "utf8")).toBeLessThan(CALLER_SCHEMA_LIMITS.maxUtf8Bytes);
    expect(() =>
      parseAndValidateCallerSchemas({
        tools: [{ name, inputSchema: { type: "object" } }],
      }),
    ).toThrow("tools[0].name exceeds UTF-8 byte limit");
    expect(stringify).not.toHaveBeenCalled();
  });

  it("counts JSON escaping in tool descriptions before schema composition", () => {
    const description = '"'.repeat(
      Math.floor(CALLER_SCHEMA_LIMITS.maxUtf8Bytes / 2),
    );
    const stringify = vi.spyOn(JSON, "stringify");

    expect(Buffer.byteLength(description, "utf8")).toBeLessThan(
      CALLER_SCHEMA_LIMITS.maxUtf8Bytes,
    );
    expect(() =>
      parseAndValidateCallerSchemas({
        tools: [{ name: "escaped", description, inputSchema: { type: "object" } }],
      }),
    ).toThrow("tools[0].description exceeds UTF-8 byte limit");
    expect(stringify).not.toHaveBeenCalled();
  });

  it("counts nested escaping when an input schema is embedded in the tool description", () => {
    const escapedValue = '"'.repeat(
      Math.floor(CALLER_SCHEMA_LIMITS.maxUtf8Bytes / 4),
    );
    const inputSchema = { type: "object", description: escapedValue };
    const serializedInputSchema = JSON.stringify(inputSchema);

    expect(Buffer.byteLength(serializedInputSchema, "utf8")).toBeLessThan(
      CALLER_SCHEMA_LIMITS.maxUtf8Bytes,
    );
    expect(() =>
      parseAndValidateCallerSchemas({
        tools: [{ name: "escapedInput", inputSchema }],
      }),
    ).toThrow("tools[0].inputSchema exceeds UTF-8 byte limit");
  });

  it("counts per-tool composition framing even when tool metadata is empty", () => {
    const tools = Array.from({ length: CALLER_SCHEMA_LIMITS.maxNodes }, () => ({
      name: "",
      inputSchema: {},
    }));

    expect(() => parseAndValidateCallerSchemas({ tools })).toThrow(
      "caller schemas exceed aggregate UTF-8 byte limit",
    );
  });

  it("rejects an oversized tool schema before materializing its full JSON serialization", () => {
    const stringify = vi.spyOn(JSON, "stringify");
    let thrown: unknown;

    try {
      parseAndValidateCallerSchemas({
        tools: [
          {
            name: "oversized",
            inputSchema: {
              type: "object",
              description: "x".repeat(CALLER_SCHEMA_LIMITS.maxUtf8Bytes + 1),
            },
          },
        ],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CallerSchemaValidationError);
    expect((thrown as Error).message).toContain("UTF-8 byte limit");
    expect(stringify).not.toHaveBeenCalled();
  });

  it("stops a wide object at the node limit before reading later property values", () => {
    const properties: Record<string, unknown> = {};
    // inputSchema root, its type value, and this properties object consume three nodes.
    for (let index = 0; index < CALLER_SCHEMA_LIMITS.maxNodes - 3; index += 1) {
      properties[`field${index}`] = 0;
    }
    const readPastLimit = vi.fn(() => {
      throw new Error("value past node limit was read");
    });
    Object.defineProperty(properties, "pastLimit", {
      enumerable: true,
      get: readPastLimit,
    });

    expect(() =>
      parseAndValidateCallerSchemas({
        tools: [{ name: "wide", inputSchema: { type: "object", properties } }],
      }),
    ).toThrow("tools[0].inputSchema exceeds node limit");
    expect(readPastLimit).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed JSON", '{"type":"object"', "must contain valid JSON"],
    ["array JSON root", "[]", 'top-level type must be "object"'],
    ["primitive JSON root", "true", 'top-level type must be "object"'],
    ["array output schema", '{"type":"array","items":{"type":"string"}}', 'top-level type must be "object"'],
    ["missing output type", '{"properties":{}}', 'top-level type must be "object"'],
  ])("rejects %s with a stable validation error", (_label, schema, message) => {
    expect(() => parseCallerOutputSchema(schema)).toThrow(
      CallerSchemaValidationError,
    );
    expect(() => parseCallerOutputSchema(schema)).toThrow(message);
  });
});
