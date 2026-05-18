/**
 * JSON Schema → OpenAI strict JSON Schema 변환.
 *
 * OpenAI Responses API strict 모드 요구사항:
 *  - 모든 object 에 additionalProperties: false
 *  - 모든 object properties 를 required 에 포함
 *  - optional 필드 → anyOf [original, { type: 'null' }] 로 required 유지
 *  - recursive 처리 (nested objects, arrays, allOf/anyOf/oneOf)
 */

export type JsonSchema = Record<string, unknown>;

export class StrictifierError extends Error {
  constructor(
    message: string,
    public path: string,
  ) {
    super(`strictifier: ${message} (at ${path})`);
    this.name = "StrictifierError";
  }
}

export function strictify(schema: JsonSchema): JsonSchema {
  return strictifyNode(schema, "$");
}

function strictifyNode(node: JsonSchema, path: string): JsonSchema {
  if (typeof node !== "object" || node === null) return node;

  const type = node.type as string | undefined;

  if (type === "object" || node.properties) {
    return strictifyObject(node, path);
  }

  if (type === "array") {
    return strictifyArray(node, path);
  }

  if (node.anyOf) {
    return {
      ...node,
      anyOf: (node.anyOf as JsonSchema[]).map((s, i) =>
        strictifyNode(s, `${path}.anyOf[${i}]`),
      ),
    };
  }

  if (node.oneOf) {
    return {
      ...node,
      oneOf: (node.oneOf as JsonSchema[]).map((s, i) =>
        strictifyNode(s, `${path}.oneOf[${i}]`),
      ),
    };
  }

  if (node.allOf) {
    return {
      ...node,
      allOf: (node.allOf as JsonSchema[]).map((s, i) =>
        strictifyNode(s, `${path}.allOf[${i}]`),
      ),
    };
  }

  if (node.$ref) {
    return { ...node };
  }

  return { ...node };
}

function strictifyObject(node: JsonSchema, path: string): JsonSchema {
  const properties = node.properties as Record<string, JsonSchema> | undefined;
  if (!properties) {
    return { ...node, additionalProperties: false };
  }

  const existingRequired = new Set(
    (node.required as string[] | undefined) ?? [],
  );
  const allKeys = Object.keys(properties);

  const strictProps: Record<string, JsonSchema> = {};
  for (const key of allKeys) {
    const prop = properties[key]!;
    const strictProp = strictifyNode(prop, `${path}.${key}`);

    if (!existingRequired.has(key)) {
      strictProps[key] = makeNullable(strictProp);
    } else {
      strictProps[key] = strictProp;
    }
  }

  const result: JsonSchema = {
    ...node,
    type: "object",
    properties: strictProps,
    required: allKeys,
    additionalProperties: false,
  };

  return result;
}

function strictifyArray(node: JsonSchema, path: string): JsonSchema {
  const items = node.items as JsonSchema | undefined;
  if (!items) return { ...node };

  return {
    ...node,
    items: strictifyNode(items, `${path}.items`),
  };
}

function makeNullable(schema: JsonSchema): JsonSchema {
  if (schema.type === "null") return schema;

  if (schema.anyOf) {
    const variants = schema.anyOf as JsonSchema[];
    const hasNull = variants.some((v) => v.type === "null");
    if (hasNull) return schema;
    return { anyOf: [...variants, { type: "null" }] };
  }

  if (schema.oneOf) {
    const variants = schema.oneOf as JsonSchema[];
    const hasNull = variants.some((v) => v.type === "null");
    if (hasNull) return schema;
    return { oneOf: [...variants, { type: "null" }] };
  }

  return { anyOf: [schema, { type: "null" }] };
}
