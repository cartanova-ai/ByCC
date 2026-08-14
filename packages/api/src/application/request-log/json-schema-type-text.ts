/**
 * JSON Schema → 간결한 TypeScript `type` 선언 텍스트.
 *
 * 라이브러리(json-schema-to-typescript 계열)는 interface + maxItems 튜플 유니온 등
 * 장황한 출력을 내서 detail 화면 요약용으로 부적합하다. qgrid 가 받는 스키마는
 * zod 직렬화 산물(object root, draft-07 부분집합)이라 이 정도 지원이면 충분하고,
 * 모르는 키워드는 unknown 으로 접어 절대 던지지 않는다.
 */

type SchemaNode = Record<string, unknown>;

const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

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

function renderNode(node: unknown, depth: number): string {
  if (node === true) return "unknown";
  if (!node || typeof node !== "object" || Array.isArray(node)) return "unknown";
  const schema = node as SchemaNode;

  if (Array.isArray(schema.enum)) {
    return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
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

/** 실패(파싱 불가 등) 시 null — 호출부가 표시 자체를 생략한다. */
export function renderJsonSchemaTypeText(schemaJson: string, name = "Response"): string | null {
  try {
    const schema = JSON.parse(schemaJson) as unknown;
    const body = renderNode(schema, 0);
    return `type ${name} = ${body}`;
  } catch {
    return null;
  }
}
