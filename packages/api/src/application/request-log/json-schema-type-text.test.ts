import { describe, expect, it } from "vitest";

import {
  renderJsonSchemaZodShapeText,
  renderJsonSchemaTypeText,
  renderParsedJsonSchemaTypeText,
} from "./json-schema-type-text";

function schema(value: unknown): string {
  return JSON.stringify(value);
}

describe("renderJsonSchemaTypeText", () => {
  it("preserves the existing parsed-schema output across supported node kinds", () => {
    expect(
      renderParsedJsonSchemaTypeText({
        type: "object",
        properties: {
          mode: { anyOf: [{ const: "fast" }, { const: "safe" }] },
          attempts: { type: "integer" },
          tag: { type: ["string", "null"] },
          options: {
            type: "object",
            properties: {
              enabled: { type: "boolean" },
              opaque: { format: "custom" },
            },
            required: ["enabled"],
          },
        },
        required: ["mode", "attempts", "tag", "options"],
      }),
    ).toBe(
      [
        "type Response = {",
        '  mode: "fast" | "safe"',
        "  attempts: number",
        "  tag: string | null",
        "  options: {",
        "    enabled: boolean",
        "    opaque?: unknown",
        "  }",
        "}",
      ].join("\n"),
    );
  });

  it("renders a flat object with optionality from required", () => {
    const result = renderJsonSchemaTypeText(
      schema({
        type: "object",
        properties: {
          dish: { type: "string" },
          spiceLevel: { type: "number" },
          note: { type: "string" },
        },
        required: ["dish", "spiceLevel"],
      }),
    );
    expect(result).toBe(
      ["type Response = {", "  dish: string", "  spiceLevel: number", "  note?: string", "}"].join(
        "\n",
      ),
    );
  });

  it("renders nested arrays of objects without tuple unions", () => {
    const result = renderJsonSchemaTypeText(
      schema({
        type: "object",
        properties: {
          sides: {
            type: "array",
            // maxItems 는 요약에서 무시한다 — 튜플 유니온 장황함이 이 렌더러를 만든 이유다.
            maxItems: 3,
            items: {
              type: "object",
              properties: { name: { type: "string" }, required: { type: "boolean" } },
              required: ["name", "required"],
            },
          },
        },
        required: ["sides"],
      }),
    );
    expect(result).toContain("sides: {");
    expect(result).toContain("}[]");
    expect(result).not.toContain("|");
  });

  it("renders enum, const, union, and nullable types", () => {
    expect(
      renderJsonSchemaTypeText(
        schema({
          type: "object",
          properties: {
            kind: { enum: ["add", "modify"] },
            version: { const: 2 },
            id: { anyOf: [{ type: "string" }, { type: "number" }] },
            tag: { type: ["string", "null"] },
            ids: { type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } },
          },
          required: ["kind", "version", "id", "tag", "ids"],
        }),
      ),
    ).toBe(
      [
        "type Response = {",
        '  kind: "add" | "modify"',
        "  version: 2",
        "  id: string | number",
        "  tag: string | null",
        "  ids: (string | number)[]",
        "}",
      ].join("\n"),
    );
  });

  it("quotes non-identifier keys and folds unknown keywords to unknown", () => {
    const result = renderJsonSchemaTypeText(
      schema({
        type: "object",
        properties: { "not-ident": { format: "weird" }, empty: { type: "object" } },
        required: ["not-ident"],
      }),
    );
    expect(result).toContain('"not-ident": unknown');
    expect(result).toContain("empty?: Record<string, unknown>");
  });

  it("returns null on unparseable schema text", () => {
    expect(renderJsonSchemaTypeText("{broken")).toBeNull();
  });
});

describe("renderJsonSchemaZodShapeText", () => {
  it("renders a compact object shape with required, optional, and default annotations", () => {
    expect(
      renderJsonSchemaZodShapeText(
        {
          type: "object",
          properties: {
            limit: { type: "integer", default: 10, maximum: 100 },
            query: { type: "string", minLength: 1, pattern: "^[a-z]+$" },
          },
          required: ["query"],
        },
        6,
      ),
    ).toBe(
      [
        "z.object({",
        "  query: z.string(),",
        "  limit: z.number().optional(), // default=10",
        "})",
      ].join("\n"),
    );
  });

  it("shortens long string enums with an inline remainder comment", () => {
    expect(
      renderJsonSchemaZodShapeText(
        {
          type: "object",
          properties: {
            mode: { enum: ["one", "two", "three", "four", "five", "six", "seven", "eight"] },
          },
          required: ["mode"],
        },
        6,
      ),
    ).toBe(
      [
        "z.object({",
        '  mode: z.enum(["one", "two", "three", "four", "five", "six" /* +2 */]),',
        "})",
      ].join("\n"),
    );
  });

  it("renders nested objects, arrays, unions, literals, and unknown nodes", () => {
    expect(
      renderJsonSchemaZodShapeText({
        type: "object",
        properties: {
          filters: {
            type: "object",
            properties: {
              tags: { type: "array", items: { type: "string" } },
              value: { anyOf: [{ const: 1 }, { type: "boolean" }] },
            },
            required: ["tags"],
          },
          opaque: { format: "custom" },
        },
        required: ["filters", "opaque"],
      }),
    ).toBe(
      [
        "z.object({",
        "  filters: z.object({",
        "    tags: z.array(z.string()),",
        "    value: z.union([z.literal(1), z.boolean()]).optional(),",
        "  }),",
        "  opaque: z.unknown(),",
        "})",
      ].join("\n"),
    );
  });
});
