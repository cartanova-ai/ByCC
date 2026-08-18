/**
 * JSON Schema → 간결한 TypeScript `type` 선언 텍스트.
 *
 * 라이브러리(json-schema-to-typescript 계열)는 interface + maxItems 튜플 유니온 등
 * 장황한 출력을 내서 detail 화면 요약용으로 부적합하다. qgrid 가 받는 스키마는
 * zod 직렬화 산물(object root, draft-07 부분집합)이라 이 정도 지원이면 충분하고,
 * 모르는 키워드는 unknown 으로 접어 절대 던지지 않는다.
 */

type SchemaNode = Record<string, unknown>;

/** TS/zod 표시 코드 공용 식별자 판별 — zod-code-format 의 키 unquote 도 이걸 쓴다. */
export const IDENT_SOURCE = "[A-Za-z_$][\\w$]*";
const IDENT_RE = new RegExp(`^${IDENT_SOURCE}$`);

function renderKey(key: string): string {
  return IDENT_RE.test(key) ? key : JSON.stringify(key);
}

function renderPrimitive(type: unknown): string {
  if (type === "string") return "string";
  if (type === "number" || type === "integer") return "number";
  if (type === "boolean") return "boolean";
  if (type === "null") return "null";
  return "unknown";
}

function renderZodPrimitive(type: unknown): string {
  if (type === "string") return "z.string()";
  if (type === "number" || type === "integer") return "z.number()";
  if (type === "boolean") return "z.boolean()";
  if (type === "null") return "z.null()";
  return "z.unknown()";
}

function renderZodEnum(values: unknown[], enumValueLimit?: number): string {
  if (values.length === 0) return "z.never()";

  const visibleValues =
    enumValueLimit === undefined ? values : values.slice(0, Math.max(0, enumValueLimit));
  const omittedCount = values.length - visibleValues.length;
  const suffix = omittedCount > 0 ? ` /* +${omittedCount} */` : "";

  if (values.every((value) => typeof value === "string")) {
    return `z.enum([${visibleValues.map((value) => JSON.stringify(value)).join(", ")}${suffix}])`;
  }

  const literals = visibleValues.map((value) => `z.literal(${JSON.stringify(value)})`);
  if (literals.length === 1 && omittedCount === 0) return literals[0] ?? "z.never()";
  return `z.union([${literals.join(", ")}${suffix}])`;
}

function renderZodNode(node: unknown, depth: number, enumValueLimit?: number): string {
  if (node === true) return "z.unknown()";
  if (!node || typeof node !== "object" || Array.isArray(node)) return "z.unknown()";
  const schema = node as SchemaNode;

  if (Array.isArray(schema.enum)) return renderZodEnum(schema.enum, enumValueLimit);
  if (schema.const !== undefined) return `z.literal(${JSON.stringify(schema.const)})`;

  const variants = (schema.anyOf ?? schema.oneOf) as unknown;
  if (Array.isArray(variants) && variants.length > 0) {
    const rendered = [
      ...new Set(variants.map((variant) => renderZodNode(variant, depth, enumValueLimit))),
    ];
    return rendered.length === 1
      ? (rendered[0] ?? "z.unknown()")
      : `z.union([${rendered.join(", ")}])`;
  }

  const type = schema.type;
  if (Array.isArray(type)) {
    const rendered = [...new Set(type.map(renderZodPrimitive))];
    return rendered.length === 1
      ? (rendered[0] ?? "z.unknown()")
      : `z.union([${rendered.join(", ")}])`;
  }

  if (type === "object" || (type === undefined && schema.properties)) {
    const properties = (schema.properties ?? {}) as Record<string, unknown>;
    const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
    const keys = Object.keys(properties);
    if (keys.length === 0) return "z.object({})";
    const orderedKeys = [
      ...keys.filter((key) => required.has(key)),
      ...keys.filter((key) => !required.has(key)),
    ];

    const inner = "  ".repeat(depth + 1);
    const lines = orderedKeys.map((key) => {
      const propertySchema = properties[key];
      const rendered = renderZodNode(propertySchema, depth + 1, enumValueLimit);
      const optional = required.has(key) ? rendered : `${rendered}.optional()`;
      const defaultValue =
        propertySchema &&
        typeof propertySchema === "object" &&
        !Array.isArray(propertySchema) &&
        Object.hasOwn(propertySchema, "default")
          ? JSON.stringify((propertySchema as SchemaNode).default)
          : undefined;
      const defaultComment = defaultValue === undefined ? "" : ` // default=${defaultValue}`;
      return `${inner}${renderKey(key)}: ${optional},${defaultComment}`;
    });
    return `z.object({\n${lines.join("\n")}\n${"  ".repeat(depth)}})`;
  }

  if (type === "array") {
    return `z.array(${renderZodNode(schema.items, depth, enumValueLimit)})`;
  }

  return renderZodPrimitive(type);
}

function renderNode(node: unknown, depth: number): string {
  if (node === true) return "unknown";
  if (!node || typeof node !== "object" || Array.isArray(node)) return "unknown";
  const schema = node as SchemaNode;

  if (Array.isArray(schema.enum)) {
    const renderedValues = schema.enum.map((value) => JSON.stringify(value));
    return renderedValues.join(" | ");
  }
  if (schema.const !== undefined) return JSON.stringify(schema.const);

  const variants = (schema.anyOf ?? schema.oneOf) as unknown;
  if (Array.isArray(variants) && variants.length > 0) {
    return [...new Set(variants.map((variant) => renderNode(variant, depth)))].join(" | ");
  }

  const type = schema.type;
  if (Array.isArray(type)) {
    return [...new Set(type.map(renderPrimitive))].join(" | ");
  }

  if (type === "object" || (type === undefined && schema.properties)) {
    const properties = (schema.properties ?? {}) as Record<string, unknown>;
    const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
    const keys = Object.keys(properties);
    if (keys.length === 0) return "Record<string, unknown>";
    const inner = "  ".repeat(depth + 1);
    const lines = keys.map(
      (key) =>
        `${inner}${renderKey(key)}${required.has(key) ? "" : "?"}: ${renderNode(properties[key], depth + 1)}`,
    );
    return `{\n${lines.join("\n")}\n${"  ".repeat(depth)}}`;
  }

  if (type === "array") {
    const item = renderNode(schema.items, depth);
    // 유니온 요소는 괄호가 없으면 `A | B[]` 로 잘못 읽힌다.
    if (item.includes(" | ")) return `(${item})[]`;
    return `${item}[]`;
  }

  return renderPrimitive(type);
}

/** 이미 파싱된 스키마 값용 — 호출부가 같은 JSON 을 두 번 파싱하지 않게 한다. */
export function renderParsedJsonSchemaTypeText(schema: unknown, name = "Response"): string {
  return `type ${name} = ${renderNode(schema, 0)}`;
}

/** Tool input 계약용 표시 전용 Zod shape. 검증 제약은 의도적으로 생략한다. */
export function renderJsonSchemaZodShapeText(schema: unknown, enumValueLimit?: number): string {
  return renderZodNode(schema, 0, enumValueLimit);
}

/** 실패(파싱 불가 등) 시 null — 호출부가 표시 자체를 생략한다. */
export function renderJsonSchemaTypeText(schemaJson: string, name = "Response"): string | null {
  try {
    return renderParsedJsonSchemaTypeText(JSON.parse(schemaJson) as unknown, name);
  } catch {
    return null;
  }
}
