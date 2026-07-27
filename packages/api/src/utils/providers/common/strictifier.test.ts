import { describe, expect, it } from "vitest";

import { type JsonSchema, strictify } from "./strictifier";

describe("strictify schema-bearing siblings", () => {
  it("strictifies both $defs and legacy definitions", () => {
    const result = strictify({
      $defs: {
        Current: {
          type: "object",
          properties: { value: { type: "string" } },
        },
      },
      definitions: {
        Legacy: {
          type: "object",
          properties: { count: { type: "number" } },
        },
      },
    });

    expect(result.$defs).toMatchObject({
      Current: {
        required: ["value"],
        additionalProperties: false,
      },
    });
    expect(result.definitions).toMatchObject({
      Legacy: {
        required: ["count"],
        additionalProperties: false,
      },
    });
  });

  it("strictifies object properties and a sibling combinator", () => {
    const result = strictify({
      type: "object",
      properties: {
        direct: {
          type: "object",
          properties: { value: { type: "string" } },
        },
      },
      required: ["direct"],
      allOf: [
        {
          type: "object",
          properties: { combined: { type: "string" } },
        },
      ],
    });

    expect(result).toMatchObject({
      required: ["direct"],
      additionalProperties: false,
      properties: {
        direct: {
          required: ["value"],
          additionalProperties: false,
        },
      },
      allOf: [
        {
          required: ["combined"],
          additionalProperties: false,
        },
      ],
    });
  });

  it("strictifies multiple combinator keywords on the same node", () => {
    const result = strictify({
      anyOf: [
        {
          type: "object",
          properties: { any: { type: "string" } },
        },
      ],
      oneOf: [
        {
          type: "object",
          properties: { one: { type: "string" } },
        },
      ],
      allOf: [
        {
          type: "object",
          properties: { all: { type: "string" } },
        },
      ],
    });

    expect(result.anyOf).toMatchObject([
      { required: ["any"], additionalProperties: false },
    ]);
    expect(result.oneOf).toMatchObject([
      { required: ["one"], additionalProperties: false },
    ]);
    expect(result.allOf).toMatchObject([
      { required: ["all"], additionalProperties: false },
    ]);
  });

  it("strictifies draft 2020-12 prefixItems tuple members", () => {
    const result = strictify({
      type: "array",
      prefixItems: [
        {
          type: "object",
          properties: { label: { type: "string" } },
        },
        { type: "integer" },
      ],
      minItems: 2,
      maxItems: 2,
    });

    expect(result.prefixItems).toMatchObject([
      {
        required: ["label"],
        additionalProperties: false,
      },
      { type: "integer" },
    ]);
  });

  it("preserves and strictifies legacy tuple arrays in items", () => {
    const result = strictify({
      type: "array",
      items: [
        {
          type: "object",
          properties: { label: { type: "string" } },
        },
        { type: "integer" },
      ],
    });

    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items).toMatchObject([
      {
        required: ["label"],
        additionalProperties: false,
      },
      { type: "integer" },
    ]);
  });

  it("normalizes a generated draft-07 tuple for OpenAI without losing positions", () => {
    const result = strictify(
      {
        type: "array",
        items: [
          {
            type: "object",
            properties: { label: { type: "string" } },
          },
          { type: "integer" },
        ],
      },
      { provider: "openai" },
    );

    expect(result).toMatchObject({
      prefixItems: [
        {
          required: ["label"],
          additionalProperties: false,
        },
        { type: "integer" },
      ],
      items: { type: "string" },
      minItems: 2,
      maxItems: 2,
    });
    expect(Array.isArray(result.items)).toBe(false);
    expect(result).not.toHaveProperty("additionalItems");
  });

  it("rejects positional tuples on Anthropic instead of weakening item positions", () => {
    expect(() =>
      strictify(
        {
          type: "array",
          items: [
            {
              type: "object",
              properties: { label: { type: "string" } },
            },
            { type: "integer" },
          ],
        },
        { provider: "anthropic" },
      ),
    ).toThrow(/positional tuple schemas are not supported on Anthropic/);
  });

  it.each([
    ["missing", undefined],
    ["nullable union", ["array", "null"]],
  ] as const)(
    "rejects an OpenAI positional tuple with %s type instead of bypassing normalization",
    (_label, type) => {
      expect(() =>
        strictify(
          {
            ...(type === undefined ? {} : { type }),
            items: [{ type: "string" }, { type: "integer" }],
          },
          { provider: "openai" },
        ),
      ).toThrow(/positional tuple schemas must declare type "array"/);
    },
  );

  it.each([
    ["missing", undefined],
    ["nullable union", ["array", "null"]],
  ] as const)(
    "rejects an Anthropic positional tuple with %s type before provider dispatch",
    (_label, type) => {
      expect(() =>
        strictify(
          {
            ...(type === undefined ? {} : { type }),
            prefixItems: [{ type: "string" }, { type: "integer" }],
          },
          { provider: "anthropic" },
        ),
      ).toThrow(/positional tuple schemas are not supported on Anthropic/);
    },
  );

  it.each([
    ["not", { not: { type: "array", items: [{ type: "string" }] } }],
    ["if", { if: { type: "array", items: [{ type: "string" }] } }],
    ["contains", { contains: { type: "array", items: [{ type: "string" }] } }],
    [
      "patternProperties",
      {
        patternProperties: {
          "^tuple$": { type: "array", items: [{ type: "string" }] },
        },
      },
    ],
    [
      "dependentSchemas",
      {
        dependentSchemas: {
          tuple: { type: "array", items: [{ type: "string" }] },
        },
      },
    ],
    [
      "dependencies",
      {
        dependencies: {
          tuple: { type: "array", items: [{ type: "string" }] },
        },
      },
    ],
  ] as const)(
    "finds an Anthropic positional tuple nested under %s",
    (_keyword, nestedSchema) => {
      expect(() =>
        strictify(
          {
            type: "object",
            ...nestedSchema,
          },
          { provider: "anthropic" },
        ),
      ).toThrow(/positional tuple schemas are not supported on Anthropic/);
    },
  );

  it.each([
    ["not", { not: { type: "array", items: [{ type: "string" }] } }],
    [
      "patternProperties",
      {
        patternProperties: {
          "^tuple$": { type: "array", items: [{ type: "string" }] },
        },
      },
    ],
  ] as const)(
    "rejects an OpenAI positional tuple under unsupported %s without rewriting it",
    (_keyword, nestedSchema) => {
      expect(() =>
        strictify(
          {
            type: "object",
            ...nestedSchema,
          },
          { provider: "openai" },
        ),
      ).toThrow(/positional tuple schemas are not supported in this schema position/);
    },
  );

  it.each(["$defs", "definitions"] as const)(
    "rejects an OpenAI reference from not into %s before globally normalizing its target",
    (keyword) => {
      const refPrefix = keyword === "$defs" ? "$defs" : "definitions";
      expect(() =>
        strictify(
          {
            type: "object",
            [keyword]: {
              Forbidden: {
                type: "object",
                properties: { value: { const: 0 } },
                required: ["value"],
              },
            },
            not: { $ref: `#/${refPrefix}/Forbidden` },
          },
          { provider: "openai" },
        ),
      ).toThrow(/schema references are not supported in this schema position/);
    },
  );

  it("normalizes a positional tuple definition referenced from a positive property", () => {
    const result = strictify(
      {
        type: "object",
        properties: {
          tuple: { $ref: "#/$defs/Tuple" },
        },
        required: ["tuple"],
        $defs: {
          Tuple: {
            type: "array",
            items: [{ type: "string" }],
          },
        },
      },
      { provider: "openai" },
    );

    expect((result.$defs as Record<string, JsonSchema>).Tuple).toMatchObject({
      prefixItems: [{ type: "string" }],
      minItems: 1,
      maxItems: 1,
    });
  });

  it.each(["openai", "anthropic"] as const)(
    "rejects a %s ref target hidden in a literal JSON position",
    (provider) => {
      expect(() =>
        strictify(
          {
            type: "object",
            properties: {
              payload: { $ref: "#/$defs/Carrier/enum/0" },
            },
            required: ["payload"],
            $defs: {
              Carrier: {
                enum: [
                  {
                    type: "array",
                    items: [{ type: "string" }],
                  },
                ],
              },
            },
          },
          { provider },
        ),
      ).toThrow(/\$ref target must be the document root or a definition root/);
    },
  );

  it.each(["openai", "anthropic"] as const)(
    "rejects a %s positive ref to a non-normalizable schema position",
    (provider) => {
      expect(() =>
        strictify(
          {
            type: "object",
            properties: {
              payload: { $ref: "#/if" },
            },
            required: ["payload"],
            if: {
              type: "object",
              properties: { secret: { type: "string" } },
            },
          },
          { provider },
        ),
      ).toThrow(/\$ref target must be the document root or a definition root/);
    },
  );

  it.each([
    [
      "an optional property",
      {
        type: "object",
        properties: {
          optionalSource: { type: "string" },
          requiredAlias: { $ref: "#/properties/optionalSource" },
        },
        required: ["requiredAlias"],
      },
    ],
    [
      "a legacy tuple member",
      {
        type: "object",
        properties: {
          alias: { $ref: "#/$defs/Tuple/items/0" },
        },
        required: ["alias"],
        $defs: {
          Tuple: {
            type: "array",
            items: [{ type: "string" }],
          },
        },
      },
    ],
    [
      "a legacy tuple tail",
      {
        type: "object",
        properties: {
          alias: { $ref: "#/$defs/Tuple/additionalItems" },
        },
        required: ["alias"],
        $defs: {
          Tuple: {
            type: "array",
            items: [{ type: "string" }],
            additionalItems: { type: "number" },
          },
        },
      },
    ],
  ] as const)("rejects a ref target inside %s before its pointer can change", (_label, schema) => {
    expect(() => strictify(schema, { provider: "openai" })).toThrow(
      /\$ref target must be the document root or a definition root/,
    );
  });

  it("resolves escaped local JSON Pointer tokens to positive definitions", () => {
    const result = strictify(
      {
        type: "object",
        properties: {
          value: { $ref: "#/$defs/Slash~1Tilde~0Value" },
        },
        required: ["value"],
        $defs: {
          "Slash/Tilde~Value": { type: "string" },
        },
      },
      { provider: "openai" },
    );

    expect((result.properties as Record<string, JsonSchema>).value).toEqual({
      $ref: "#/$defs/Slash~1Tilde~0Value",
    });
  });

  it("treats reused JavaScript objects the same as their serialized JSON value", () => {
    const reusedSchema = { type: "string" };
    const input = {
      type: "object",
      properties: {
        value: { $ref: "#/$defs/Value" },
      },
      required: ["value"],
      $defs: { Value: reusedSchema },
      not: reusedSchema,
    };
    const serializedCopy = JSON.parse(JSON.stringify(input)) as JsonSchema;

    expect(strictify(input, { provider: "openai" })).toEqual(
      strictify(serializedCopy, { provider: "openai" }),
    );
  });

  it("does not materialize inherited schema keywords or resolve refs through them", () => {
    const inheritedDefinitions = {
      $defs: {
        Injected: { type: "string" },
      },
    };
    const input = Object.assign(Object.create(inheritedDefinitions) as JsonSchema, {
      type: "object",
      properties: {
        value: { $ref: "#/$defs/Injected" },
      },
      required: ["value"],
    });

    expect(() => strictify(input, { provider: "anthropic" })).toThrow(
      /\$ref does not resolve inside the caller schema/,
    );

    const withoutRef = Object.assign(Object.create(inheritedDefinitions) as JsonSchema, {
      type: "object",
      properties: {},
      required: [],
    });
    const result = strictify(withoutRef, { provider: "anthropic" });
    expect(Object.hasOwn(result, "$defs")).toBe(false);
  });

  it.each([
    ["external ref", { $ref: "https://example.com/schema.json" }, /only local root-relative/],
    ["anchor ref", { $ref: "#named" }, /only local root-relative/],
    ["missing target", { $ref: "#/$defs/Missing" }, /does not resolve/],
    ["non-string ref", { $ref: 7 }, /\$ref must be a string/],
    ["resource id", { $id: "urn:example:schema" }, /\$id is not supported/],
    ["legacy resource id", { id: "legacy-id" }, /id is not supported/],
    ["anchor", { $anchor: "named" }, /\$anchor is not supported/],
    ["dynamic ref", { $dynamicRef: "#node" }, /\$dynamicRef is not supported/],
    ["recursive ref", { $recursiveRef: "#" }, /\$recursiveRef is not supported/],
  ] as const)("rejects unsupported %s features", (_label, propertySchema, message) => {
    expect(() =>
      strictify(
        {
          type: "object",
          properties: { value: propertySchema },
          required: ["value"],
          $defs: {},
        },
        { provider: "openai" },
      ),
    ).toThrow(message);
  });

  it("preserves a negative not subschema instead of tightening and reversing its meaning", () => {
    const negativeSchema = {
      properties: {
        value: { const: 0 },
      },
      required: ["value"],
    };
    const result = strictify(
      {
        type: "object",
        properties: {
          value: { type: "number" },
          tag: { type: "string" },
        },
        required: ["value", "tag"],
        not: negativeSchema,
      },
      { provider: "openai" },
    );

    expect(result.not).toEqual(negativeSchema);
  });

  it("preserves a typed draft-07 tuple rest for OpenAI", () => {
    const result = strictify(
      {
        type: "array",
        items: [{ type: "string" }],
        additionalItems: {
          type: "object",
          properties: { value: { type: "integer" } },
        },
      },
      { provider: "openai" },
    );

    expect(result).toMatchObject({
      prefixItems: [{ type: "string" }],
      items: {
        required: ["value"],
        additionalProperties: false,
      },
      minItems: 1,
    });
    expect(result.maxItems).toBeUndefined();
    expect(result).not.toHaveProperty("additionalItems");
  });

  it("rejects an explicitly unrestricted tuple rest for OpenAI", () => {
    for (const additionalItems of [
      true,
      {},
      { description: "accept anything" },
      { $comment: "accept anything" },
    ]) {
      expect(() =>
        strictify(
          {
            type: "array",
            items: [{ type: "string" }],
            additionalItems,
          },
          { provider: "openai" },
        ),
      ).toThrow(/unrestricted tuple rest is not supported/);
    }
  });

  it("rejects an unrestricted tuple member for OpenAI", () => {
    for (const item of [
      {},
      { description: "accept anything" },
      { $schema: "http://json-schema.org/draft-07/schema#" },
    ]) {
      expect(() =>
        strictify(
          {
            type: "array",
            items: [item],
          },
          { provider: "openai" },
        ),
      ).toThrow(/tuple member must define a provider-representable schema/);
    }
  });

  it("normalizes a fixed prefixItems tuple for OpenAI", () => {
    const result = strictify(
      {
        type: "array",
        prefixItems: [{ type: "string" }, { type: "integer" }],
      },
      { provider: "openai" },
    );

    expect(result).toMatchObject({
      prefixItems: [{ type: "string" }, { type: "integer" }],
      items: { type: "string" },
      minItems: 2,
      maxItems: 2,
    });
    expect(Array.isArray(result.items)).toBe(false);
  });

  it.each(["openai", "anthropic"] as const)("normalizes an empty tuple for %s", (provider) => {
    const result = strictify(
      {
        type: "array",
        items: [],
      },
      { provider },
    );

    expect(result).toMatchObject({
      items: { type: "string" },
      minItems: 0,
      maxItems: 0,
    });
    expect(result).not.toHaveProperty("prefixItems");
  });

  it("preserves explicit optional bounds while closing a draft-07 tuple", () => {
    const result = strictify(
      {
        type: "array",
        items: [{ type: "string" }, { type: "integer" }],
        additionalItems: false,
        minItems: 1,
        maxItems: 99,
      },
      { provider: "openai" },
    );

    expect(result).toMatchObject({
      minItems: 1,
      maxItems: 2,
    });
  });

  it("rejects an implicit draft-07 tail when an explicit bound reaches beyond the tuple", () => {
    expect(() =>
      strictify(
        {
          type: "array",
          items: [{ type: "string" }, { type: "integer" }],
          maxItems: 3,
        },
        { provider: "openai" },
      ),
    ).toThrow(/implicit tuple rest cannot be represented/);
  });

  it("rejects mixed-dialect tuple keywords", () => {
    expect(() =>
      strictify(
        {
          type: "array",
          prefixItems: [{ type: "string" }],
          additionalItems: false,
        },
        { provider: "openai" },
      ),
    ).toThrow(/additionalItems cannot be combined with prefixItems/);
  });

  it("removes a stale draft declaration from the OpenAI dispatch copy without mutation", () => {
    const input = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "array",
      items: [{ type: "string" }],
    };
    const before = structuredClone(input);
    const result = strictify(input, { provider: "openai" });

    expect(result).not.toHaveProperty("$schema");
    expect(input).toEqual(before);
  });

  it("preserves prototype-sensitive property names as own data properties", () => {
    const propertyNames = ["__proto__", "constructor", "prototype"];
    const properties = JSON.parse(
      '{"__proto__":{"type":"string"},"constructor":{"type":"integer"},"prototype":{"type":"boolean"}}',
    ) as Record<string, JsonSchema>;

    const result = strictify({
      type: "object",
      properties,
      required: propertyNames,
    });
    const strictProperties = result.properties as Record<string, JsonSchema>;

    for (const propertyName of propertyNames) {
      expect(Object.prototype.hasOwnProperty.call(strictProperties, propertyName)).toBe(true);
    }
    expect(Object.getPrototypeOf(strictProperties)).toBe(Object.prototype);
    expect(strictProperties.__proto__).toEqual({ type: "string" });

    const serializedProperties = (
      JSON.parse(JSON.stringify(result)) as {
        properties: Record<string, JsonSchema>;
      }
    ).properties;
    expect(Object.keys(serializedProperties)).toEqual(propertyNames);
    expect(serializedProperties.__proto__).toEqual({ type: "string" });
  });
});
