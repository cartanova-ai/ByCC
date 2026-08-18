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

function renderNode(node: unknown, depth: number, enumValueLimit?: number): string {
  if (node === true) return "unknown";
  if (!node || typeof node !== "object" || Array.isArray(node)) return "unknown";
  const schema = node as SchemaNode;

  if (Array.isArray(schema.enum)) {
    const renderedValues = schema.enum.map((value) => JSON.stringify(value));
    if (enumValueLimit !== undefined && renderedValues.length > enumValueLimit) {
      const remainderCount = renderedValues.length - enumValueLimit;
      return `${renderedValues.slice(0, enumValueLimit).join(" | ")} … (+${remainderCount})`;
    }
    return renderedValues.join(" | ");
  }
  if (schema.const !== undefined) return JSON.stringify(schema.const);

  const variants = (schema.anyOf ?? schema.oneOf) as unknown;
  if (Array.isArray(variants) && variants.length > 0) {
    return [...new Set(variants.map((variant) => renderNode(variant, depth, enumValueLimit)))].join(
      " | ",
    );
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
        `${inner}${renderKey(key)}${required.has(key) ? "" : "?"}: ${renderNode(properties[key], depth + 1, enumValueLimit)}`,
    );
    return `{\n${lines.join("\n")}\n${"  ".repeat(depth)}}`;
  }

  if (type === "array") {
    const item = renderNode(schema.items, depth, enumValueLimit);
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

/** 도구 파라미터 한 개의 표시 타입. enum 축약이 없으면 전체 타입을 중복하지 않는다. */
export function renderJsonSchemaPropertyTypeText(
  schema: unknown,
  enumValueLimit?: number,
): { type: string; fullType?: string } {
  const type = renderNode(schema, 0, enumValueLimit);
  const fullType = renderNode(schema, 0);
  return type === fullType ? { type } : { type, fullType };
}

/** 실패(파싱 불가 등) 시 null — 호출부가 표시 자체를 생략한다. */
export function renderJsonSchemaTypeText(schemaJson: string, name = "Response"): string | null {
  try {
    return renderParsedJsonSchemaTypeText(JSON.parse(schemaJson) as unknown, name);
  } catch {
    return null;
  }
}
