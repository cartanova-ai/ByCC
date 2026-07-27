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

export interface StrictifierOptions {
  provider?: string;
}

export class StrictifierError extends Error {
  constructor(
    message: string,
    public path: string,
  ) {
    super(`strictifier: ${message} (at ${path})`);
    this.name = "StrictifierError";
  }
}

export function strictify(schema: JsonSchema, options: StrictifierOptions = {}): JsonSchema {
  if (options.provider === "openai" || options.provider === "anthropic") {
    assertNormalizationCompatibility(schema, options.provider);
  }
  const result = strictifyNode(schema, "$", options.provider);
  if (options.provider === "openai" || options.provider === "anthropic") {
    assertNormalizationCompatibility(result, options.provider);
  }
  return result;
}

const SCHEMA_SCAN_MAP_KEYWORDS = [
  ["$defs", true],
  ["definitions", true],
  ["properties", true],
  ["dependentSchemas", false],
  ["patternProperties", false],
] as const;
const SCHEMA_SCAN_ARRAY_KEYWORDS = [
  ["allOf", true],
  ["anyOf", true],
  ["oneOf", true],
  ["prefixItems", true],
] as const;
const SCHEMA_SCAN_SINGLE_KEYWORDS = [
  ["additionalProperties", false],
  ["contains", false],
  ["contentSchema", false],
  ["else", false],
  ["if", false],
  ["not", false],
  ["propertyNames", false],
  ["then", false],
  ["unevaluatedItems", false],
  ["unevaluatedProperties", false],
] as const;

/**
 * Inspect every JSON Schema-bearing position without rewriting it.
 *
 * Positive positions already traversed by strictifyNode may normalize OpenAI tuples. Positions
 * such as `not` and `if` cannot be tightened without changing caller semantics, so positional
 * tuples there fail explicitly instead of leaking an unsupported provider schema. References
 * from those positions also fail because their definitions are normalized globally.
 */
function assertNormalizationCompatibility(
  schema: JsonSchema,
  provider: "openai" | "anthropic",
): void {
  const references: Array<{ value: string; path: string }> = [];
  const stack: Array<{ node: JsonSchema; path: string; normalizable: boolean }> = [
    { node: schema, path: "$", normalizable: true },
  ];

  while (stack.length > 0) {
    const current = stack.pop()!;
    const itemsValue = ownValue(current.node, "items");
    const prefixItemsValue = ownValue(current.node, "prefixItems");
    const legacyTuple = Array.isArray(itemsValue);
    const prefixTuple = Array.isArray(prefixItemsValue);

    assertUnsupportedReferenceKeywords(current.node, current.path);
    collectSchemaReference(current, references);

    if (legacyTuple || prefixTuple) {
      const tuple = (legacyTuple ? itemsValue : prefixItemsValue) as unknown[];
      if (provider === "anthropic" && tuple.length > 0) {
        throw new StrictifierError(
          "positional tuple schemas are not supported on Anthropic because Claude Code cannot preserve item positions",
          current.path,
        );
      }
      if (!current.normalizable) {
        throw new StrictifierError(
          "positional tuple schemas are not supported in this schema position",
          current.path,
        );
      }
      if (ownValue(current.node, "type") !== "array") {
        throw new StrictifierError(
          'positional tuple schemas must declare type "array"; express nullable tuples with anyOf',
          `${current.path}.type`,
        );
      }
    }

    for (const [keyword, keywordNormalizable] of SCHEMA_SCAN_MAP_KEYWORDS) {
      const schemas = ownValue(current.node, keyword);
      if (!isSchemaObject(schemas)) continue;
      for (const [name, child] of Object.entries(schemas)) {
        if (!isSchemaObject(child)) continue;
        stack.push({
          node: child,
          path: `${current.path}.${keyword}.${name}`,
          normalizable: current.normalizable && keywordNormalizable,
        });
      }
    }

    const dependencies = ownValue(current.node, "dependencies");
    if (isSchemaObject(dependencies)) {
      for (const [name, child] of Object.entries(dependencies)) {
        if (!isSchemaObject(child)) continue;
        stack.push({
          node: child,
          path: `${current.path}.dependencies.${name}`,
          normalizable: false,
        });
      }
    }

    for (const [keyword, keywordNormalizable] of SCHEMA_SCAN_ARRAY_KEYWORDS) {
      const schemas = ownValue(current.node, keyword);
      if (!Array.isArray(schemas)) continue;
      for (let index = 0; index < schemas.length; index += 1) {
        const child = schemas[index];
        if (!isSchemaObject(child)) continue;
        stack.push({
          node: child,
          path: `${current.path}.${keyword}[${index}]`,
          normalizable: current.normalizable && keywordNormalizable,
        });
      }
    }

    const items = ownValue(current.node, "items");
    if (isSchemaObject(items)) {
      stack.push({
        node: items,
        path: `${current.path}.items`,
        normalizable: current.normalizable,
      });
    } else if (Array.isArray(items)) {
      for (let index = 0; index < items.length; index += 1) {
        const child = items[index];
        if (!isSchemaObject(child)) continue;
        stack.push({
          node: child,
          path: `${current.path}.items[${index}]`,
          normalizable: current.normalizable,
        });
      }
    }

    const additionalItems = ownValue(current.node, "additionalItems");
    if (isSchemaObject(additionalItems)) {
      stack.push({
        node: additionalItems,
        path: `${current.path}.additionalItems`,
        normalizable: current.normalizable && legacyTuple,
      });
    }

    for (const [keyword, keywordNormalizable] of SCHEMA_SCAN_SINGLE_KEYWORDS) {
      const child = ownValue(current.node, keyword);
      if (!isSchemaObject(child)) continue;
      stack.push({
        node: child,
        path: `${current.path}.${keyword}`,
        normalizable: current.normalizable && keywordNormalizable,
      });
    }
  }

  assertReferenceTargets(schema, references);
}

const UNSUPPORTED_REFERENCE_KEYWORDS = [
  "$id",
  "id",
  "$anchor",
  "$dynamicAnchor",
  "$recursiveAnchor",
  "$dynamicRef",
  "$recursiveRef",
] as const;

function assertUnsupportedReferenceKeywords(schema: JsonSchema, path: string): void {
  for (const keyword of UNSUPPORTED_REFERENCE_KEYWORDS) {
    if (Object.hasOwn(schema, keyword)) {
      throw new StrictifierError(`${keyword} is not supported`, `${path}.${keyword}`);
    }
  }
}

function collectSchemaReference(
  current: { node: JsonSchema; path: string; normalizable: boolean },
  references: Array<{ value: string; path: string }>,
): void {
  if (!Object.hasOwn(current.node, "$ref")) return;

  const reference = current.node.$ref;
  if (typeof reference !== "string") {
    throw new StrictifierError("$ref must be a string", `${current.path}.$ref`);
  }
  if (!current.normalizable) {
    throw new StrictifierError(
      "schema references are not supported in this schema position",
      current.path,
    );
  }

  references.push({ value: reference, path: `${current.path}.$ref` });
}

function assertReferenceTargets(
  root: JsonSchema,
  references: Array<{ value: string; path: string }>,
): void {
  for (const reference of references) {
    const tokens = parseLocalJsonPointer(reference.value, reference.path);
    if (!isDefinitionRootPointer(tokens)) {
      throw new StrictifierError(
        "$ref target must be the document root or a definition root",
        reference.path,
      );
    }
    resolveDefinitionRoot(root, tokens, reference.path);
  }
}

function isDefinitionRootPointer(tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  if (tokens.length % 2 !== 0) return false;

  for (let index = 0; index < tokens.length; index += 2) {
    if (tokens[index] !== "$defs" && tokens[index] !== "definitions") return false;
  }
  return true;
}

function parseLocalJsonPointer(reference: string, path: string): string[] {
  if (reference === "#") return [];
  if (!reference.startsWith("#/")) {
    throw new StrictifierError(
      "only local root-relative JSON Pointer $ref values are supported",
      path,
    );
  }

  let fragment: string;
  try {
    fragment = decodeURIComponent(reference.slice(1));
  } catch {
    throw new StrictifierError("$ref contains invalid percent encoding", path);
  }
  if (!fragment.startsWith("/")) {
    throw new StrictifierError(
      "only local root-relative JSON Pointer $ref values are supported",
      path,
    );
  }

  return fragment
    .slice(1)
    .split("/")
    .map((token) => decodeJsonPointerToken(token, path));
}

function resolveDefinitionRoot(root: JsonSchema, tokens: string[], path: string): void {
  let current = root;
  for (let index = 0; index < tokens.length; index += 2) {
    const keyword = tokens[index]!;
    const name = tokens[index + 1]!;
    const definitions = ownValue(current, keyword);
    if (!isSchemaObject(definitions) || !Object.hasOwn(definitions, name)) {
      throw new StrictifierError("$ref does not resolve inside the caller schema", path);
    }
    const target = definitions[name];
    if (!isSchemaObject(target)) {
      throw new StrictifierError("$ref target must be an object schema", path);
    }
    current = target;
  }
}

function decodeJsonPointerToken(rawToken: string, path: string): string {
  let token = "";
  for (let index = 0; index < rawToken.length; index += 1) {
    const character = rawToken[index]!;
    if (character !== "~") {
      token += character;
      continue;
    }

    const escaped = rawToken[index + 1];
    if (escaped === "0") {
      token += "~";
    } else if (escaped === "1") {
      token += "/";
    } else {
      throw new StrictifierError("$ref contains an invalid JSON Pointer escape", path);
    }
    index += 1;
  }
  return token;
}

function strictifyNode(node: JsonSchema, path: string, provider?: string): JsonSchema {
  if (typeof node !== "object" || node === null) return node;

  const dialectNeutralNode = provider === "openai" ? omitKeys(node, ["$schema"]) : node;
  let result = strictifySchemaMaps(dialectNeutralNode, path, provider);
  const type = ownValue(result, "type") as string | undefined;

  if (type === "object" || Object.hasOwn(result, "properties")) {
    result = strictifyObject(result, path, provider);
  }

  if (type === "array" || Object.hasOwn(result, "items") || Object.hasOwn(result, "prefixItems")) {
    result = strictifyArray(result, path, provider);
  }

  return strictifySchemaArrays(result, path, provider);
}

const SCHEMA_MAP_KEYWORDS = ["$defs", "definitions"] as const;

function strictifySchemaMaps(node: JsonSchema, path: string, provider?: string): JsonSchema {
  const result = { ...node };

  for (const keyword of SCHEMA_MAP_KEYWORDS) {
    const schemas = ownValue(node, keyword);
    if (!isSchemaObject(schemas)) continue;

    result[keyword] = Object.fromEntries(
      Object.entries(schemas).map(([name, schema]) => [
        name,
        isSchemaObject(schema)
          ? strictifyNode(schema, `${path}.${keyword}.${name}`, provider)
          : schema,
      ]),
    );
  }

  return result;
}

const SCHEMA_ARRAY_KEYWORDS = ["anyOf", "oneOf", "allOf"] as const;

function strictifySchemaArrays(node: JsonSchema, path: string, provider?: string): JsonSchema {
  const result = { ...node };

  for (const keyword of SCHEMA_ARRAY_KEYWORDS) {
    const schemas = ownValue(node, keyword);
    if (!schemas) continue;
    result[keyword] = (schemas as JsonSchema[]).map((schema, index) =>
      strictifyNode(schema, `${path}.${keyword}[${index}]`, provider),
    );
  }

  return result;
}

function strictifyObject(node: JsonSchema, path: string, provider?: string): JsonSchema {
  const properties = ownValue(node, "properties") as Record<string, JsonSchema> | undefined;
  if (!properties) {
    return { ...node, additionalProperties: false };
  }

  const existingRequired = new Set((ownValue(node, "required") as string[] | undefined) ?? []);
  const allKeys = Object.keys(properties);

  const strictProps = Object.fromEntries(
    allKeys.map((key) => {
      const prop = properties[key]!;
      const strictProp = strictifyNode(prop, `${path}.${key}`, provider);

      return [key, existingRequired.has(key) ? strictProp : makeNullable(strictProp)];
    }),
  ) as Record<string, JsonSchema>;

  const result: JsonSchema = {
    ...node,
    type: "object",
    properties: strictProps,
    required: allKeys,
    additionalProperties: false,
  };

  return result;
}

const UNREACHABLE_TUPLE_TAIL_SCHEMA: JsonSchema = { type: "string" };

function strictifyArray(node: JsonSchema, path: string, provider?: string): JsonSchema {
  if (
    (provider === "openai" || provider === "anthropic") &&
    (Array.isArray(ownValue(node, "items")) || Array.isArray(ownValue(node, "prefixItems")))
  ) {
    return normalizeTuple(node, path, provider);
  }

  const result = { ...node };
  const items = ownValue(node, "items") as JsonSchema | JsonSchema[] | undefined;

  if (Array.isArray(items)) {
    result.items = items.map((schema, index) =>
      strictifyNode(schema, `${path}.items[${index}]`, provider),
    );
  } else if (items !== undefined) {
    result.items = strictifyNode(items, `${path}.items`, provider);
  }

  const prefixItems = ownValue(node, "prefixItems") as JsonSchema[] | undefined;
  if (Array.isArray(prefixItems)) {
    result.prefixItems = prefixItems.map((schema, index) =>
      strictifyNode(schema, `${path}.prefixItems[${index}]`, provider),
    );
  }

  return result;
}

function normalizeTuple(
  node: JsonSchema,
  path: string,
  provider: "openai" | "anthropic",
): JsonSchema {
  const items = ownValue(node, "items");
  const prefixItems = ownValue(node, "prefixItems");
  const legacyTuple = Array.isArray(items);
  const prefixTuple = Array.isArray(prefixItems);
  if (legacyTuple && prefixTuple) {
    throw new StrictifierError("items and prefixItems tuple forms cannot be combined", path);
  }
  if (prefixTuple && Object.hasOwn(node, "additionalItems")) {
    throw new StrictifierError("additionalItems cannot be combined with prefixItems", path);
  }

  const rawTuple = (legacyTuple ? items : prefixItems) as unknown[];
  const tuplePath = legacyTuple ? `${path}.items` : `${path}.prefixItems`;
  const tuple = rawTuple.map((schema, index) => {
    if (!isSchemaObject(schema)) {
      throw new StrictifierError(
        "boolean and non-object tuple member schemas are not supported",
        `${tuplePath}[${index}]`,
      );
    }
    const memberPath = `${tuplePath}[${index}]`;
    const member = strictifyNode(schema, memberPath, provider);
    if (!hasProviderSchemaEntryPoint(member)) {
      throw new StrictifierError(
        "tuple member must define a provider-representable schema",
        memberPath,
      );
    }
    return member;
  });

  const rawTail = legacyTuple ? ownValue(node, "additionalItems") : items;
  if (rawTail === true) {
    throw new StrictifierError("an unrestricted tuple rest is not supported", path);
  }
  if (rawTail !== undefined && rawTail !== false && !isSchemaObject(rawTail)) {
    throw new StrictifierError("tuple rest must be an object schema or false", path);
  }

  const tail = isSchemaObject(rawTail)
    ? strictifyNode(rawTail, legacyTuple ? `${path}.additionalItems` : `${path}.items`, provider)
    : undefined;
  if (tail !== undefined && !hasProviderSchemaEntryPoint(tail)) {
    throw new StrictifierError("an unrestricted tuple rest is not supported", path);
  }
  const tailMode = tail !== undefined ? "typed" : rawTail === false ? "closed" : "implicit";
  const bounds = normalizeTupleBounds(node, tuple.length, tailMode, path);
  const base = omitKeys(node, ["items", "prefixItems", "additionalItems", "minItems", "maxItems"]);

  // Anthropic 은 assertNormalizationCompatibility 가 비어 있지 않은 tuple 을 이미 거부했으므로
  // 여기 도달하는 tuple 은 빈 tuple 뿐이고, 그 경우 prefixItems spread 는 자연히 생략된다 —
  // provider 분기 없이 한 형태로 두 provider 모두를 표현한다.
  return {
    ...base,
    ...(tuple.length > 0 ? { prefixItems: tuple } : {}),
    items: tail ?? UNREACHABLE_TUPLE_TAIL_SCHEMA,
    ...bounds,
  };
}

function normalizeTupleBounds(
  node: JsonSchema,
  tupleLength: number,
  tailMode: "typed" | "closed" | "implicit",
  path: string,
): { minItems: number; maxItems?: number } {
  const callerMinItems = integerBound(ownValue(node, "minItems"), "minItems", path);
  const callerMaxItems = integerBound(ownValue(node, "maxItems"), "maxItems", path);
  if (tailMode === "implicit" && callerMaxItems !== undefined && callerMaxItems > tupleLength) {
    throw new StrictifierError(
      "implicit tuple rest cannot be represented when maxItems exceeds the tuple length",
      path,
    );
  }

  const minItems = callerMinItems ?? (callerMaxItems === undefined ? tupleLength : 0);
  const maxItems =
    tailMode === "typed" ? callerMaxItems : Math.min(callerMaxItems ?? tupleLength, tupleLength);

  if (maxItems !== undefined && minItems > maxItems) {
    throw new StrictifierError("tuple minItems cannot exceed maxItems", path);
  }

  return {
    minItems,
    ...(maxItems !== undefined ? { maxItems } : {}),
  };
}

function integerBound(value: unknown, keyword: string, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new StrictifierError(`${keyword} must be a non-negative safe integer`, path);
  }
  return value as number;
}

function isSchemaObject(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownValue(schema: JsonSchema, keyword: string): unknown {
  return Object.hasOwn(schema, keyword) ? schema[keyword] : undefined;
}

const PROVIDER_SCHEMA_ENTRY_POINT_KEYWORDS = new Set([
  "type",
  "$ref",
  "properties",
  "anyOf",
  "oneOf",
  "allOf",
]);

function hasProviderSchemaEntryPoint(schema: JsonSchema): boolean {
  return Object.keys(schema).some((key) => PROVIDER_SCHEMA_ENTRY_POINT_KEYWORDS.has(key));
}

function omitKeys(node: JsonSchema, keys: readonly string[]): JsonSchema {
  const omitted = new Set(keys);
  return Object.fromEntries(Object.entries(node).filter(([key]) => !omitted.has(key)));
}

function makeNullable(schema: JsonSchema): JsonSchema {
  if (ownValue(schema, "type") === "null") return schema;

  const anyOf = ownValue(schema, "anyOf");
  if (anyOf) {
    const variants = anyOf as JsonSchema[];
    const hasNull = variants.some((v) => ownValue(v, "type") === "null");
    if (hasNull) return schema;
    return { anyOf: [...variants, { type: "null" }] };
  }

  const oneOf = ownValue(schema, "oneOf");
  if (oneOf) {
    const variants = oneOf as JsonSchema[];
    const hasNull = variants.some((v) => ownValue(v, "type") === "null");
    if (hasNull) return schema;
    return { oneOf: [...variants, { type: "null" }] };
  }

  return { anyOf: [schema, { type: "null" }] };
}
