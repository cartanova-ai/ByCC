import { describe, expect, it } from "vitest";

import { type QgridTool } from "./qgrid.types";
import { buildToolCallSchema } from "./tool-emulation-schema";

const userPath = (...path: Array<string | number>) => [
  "$defs",
  "__qgrid_user_output",
  ...path,
];

describe("buildToolCallSchema", () => {
  const tools: QgridTool[] = [
    {
      name: "getWeather",
      description: "Get weather for a city",
      inputSchema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
        additionalProperties: false,
      },
    },
  ];

  it("documents that emulated tools must be requested through StructuredOutput", () => {
    const schema = buildToolCallSchema(tools);

    expect(schema).toHaveProperty(
      "description",
      expect.stringContaining("Do not invoke listed client tools as native Claude Code tools"),
    );
    expect(schema).toHaveProperty(
      ["properties", "result", "anyOf", 1, "description"],
      expect.stringContaining("Do not call these tools as native"),
    );
    expect(schema).toHaveProperty(
      [
        "properties",
        "result",
        "anyOf",
        1,
        "properties",
        "toolCalls",
        "items",
        "properties",
        "toolName",
        "description",
      ],
      expect.stringContaining("getWeather"),
    );
  });

  it("makes degenerate combinations grammatically impossible", () => {
    const schema = buildToolCallSchema(tools);

    expect(schema).not.toHaveProperty("$defs");
    // answer 변형: answer 는 비 null string 필수, toolCalls 는 null 고정.
    expect(schema).toHaveProperty(["properties", "result", "anyOf", 0, "properties", "answer"], {
      type: "string",
    });
    expect(schema).toHaveProperty(["properties", "result", "anyOf", 0, "properties", "toolCalls"], {
      type: "null",
    });
    // tool_call 변형: toolCalls 1개 이상 필수, answer 는 null 고정.
    expect(schema).toHaveProperty(
      ["properties", "result", "anyOf", 1, "properties", "toolCalls", "minItems"],
      1,
    );
    expect(schema).toHaveProperty(["properties", "result", "anyOf", 1, "properties", "answer"], {
      type: "null",
    });
    // OpenAI structured outputs 제약: 루트는 object, union 은 result property 아래 중첩.
    expect(schema).toHaveProperty("type", "object");
    expect(schema).toHaveProperty("required", ["result"]);
  });

  it("namespaces a user schema and references it from answer", () => {
    const userSchema = {
      type: "object",
      properties: { translated: { type: "string" } },
    };
    const schema = buildToolCallSchema(tools, userSchema);

    expect(schema).toHaveProperty(["properties", "result", "anyOf", 0, "properties", "answer"], {
      $ref: "#/$defs/__qgrid_user_output",
    });
    expect(schema).toHaveProperty(userPath(), userSchema);
  });

  it("rebases root and nested local refs into the user-schema namespace", () => {
    const schema = buildToolCallSchema(tools, {
      type: "object",
      properties: {
        self: { $ref: "#" },
        item: { $ref: "#/$defs/Item" },
      },
      $defs: {
        Item: {
          type: "object",
          properties: { parent: { $ref: "#" } },
        },
      },
    });

    expect(schema).toHaveProperty(
      userPath("properties", "self", "$ref"),
      "#/$defs/__qgrid_user_output",
    );
    expect(schema).toHaveProperty(
      userPath("properties", "item", "$ref"),
      "#/$defs/__qgrid_user_output/$defs/Item",
    );
    expect(schema).toHaveProperty(
      userPath("$defs", "Item", "properties", "parent", "$ref"),
      "#/$defs/__qgrid_user_output",
    );
  });

  it("only traverses schema positions and preserves property names and literal data", () => {
    const literal = {
      $id: "literal-id",
      $ref: "https://example.com/literal.json",
      $dynamicRef: "#literal",
    };
    const schema = buildToolCallSchema(tools, {
      type: "object",
      properties: {
        $id: { type: "string" },
        $ref: { type: "string" },
        payload: {
          type: "object",
          const: literal,
          enum: [literal],
          default: literal,
          examples: [literal],
        },
      },
      patternProperties: {
        "^\\$dynamicRef$": { type: "string" },
      },
      dependentSchemas: {
        $dynamicRef: {
          type: "object",
          properties: { value: { $ref: "#" } },
        },
      },
    });

    expect(schema).toHaveProperty(userPath("properties", "$id"), { type: "string" });
    expect(schema).toHaveProperty(userPath("properties", "$ref"), { type: "string" });
    expect(schema).toHaveProperty(userPath("patternProperties", "^\\$dynamicRef$"), {
      type: "string",
    });
    expect(schema).toHaveProperty(userPath("properties", "payload", "const"), literal);
    expect(schema).toHaveProperty(userPath("properties", "payload", "enum"), [literal]);
    expect(schema).toHaveProperty(userPath("properties", "payload", "default"), literal);
    expect(schema).toHaveProperty(userPath("properties", "payload", "examples"), [literal]);
    expect(schema).toHaveProperty(
      userPath("dependentSchemas", "$dynamicRef", "properties", "value", "$ref"),
      "#/$defs/__qgrid_user_output",
    );
  });

  it("rebases draft-07 additionalItems and schema dependencies while preserving property dependencies", () => {
    const schema = buildToolCallSchema(tools, {
      type: "array",
      items: [{ type: "string" }],
      additionalItems: { $ref: "#/$defs/Extra" },
      dependencies: {
        triggerSchema: {
          type: "object",
          properties: { extra: { $ref: "#/$defs/Extra" } },
        },
        triggerProperties: ["first", "$ref", "$id"],
      },
      $defs: {
        Extra: { type: "string" },
      },
    });

    expect(schema).toHaveProperty(
      userPath("additionalItems", "$ref"),
      "#/$defs/__qgrid_user_output/$defs/Extra",
    );
    expect(schema).toHaveProperty(
      userPath("dependencies", "triggerSchema", "properties", "extra", "$ref"),
      "#/$defs/__qgrid_user_output/$defs/Extra",
    );
    expect(schema).toHaveProperty(
      userPath("dependencies", "triggerProperties"),
      ["first", "$ref", "$id"],
    );
  });

  it.each([
    [{ $ref: "https://example.com/schema.json" }, "$.$ref"],
    [{ $ref: "#named-anchor" }, "$.$ref"],
    [{ $id: "urn:example:schema", type: "object" }, "$.$id"],
    [{ $dynamicRef: "#node" }, "$.$dynamicRef"],
    [{ $recursiveRef: "#" }, "$.$recursiveRef"],
    [{ $recursiveAnchor: true }, "$.$recursiveAnchor"],
  ])("rejects unsupported reference features with their path", (answerSchema, path) => {
    expect(() => buildToolCallSchema(tools, answerSchema)).toThrowError(
      expect.objectContaining({ path }),
    );
  });
});
