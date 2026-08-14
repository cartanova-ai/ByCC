/**
 * json-schema-to-zod 출력(한 줄 표현식)을 표시용으로 정리한다.
 *
 * - object 리터럴 경계(`{`, `}`, 멤버 `,`)에서만 줄을 바꾼다 — 메서드 체인과
 *   배열/인자 목록은 한 줄 유지가 더 읽기 좋다.
 * - `"dish":` 처럼 식별자인데 따옴표가 붙은 키는 따옴표를 벗긴다.
 * - 문자열 리터럴 내부는 절대 건드리지 않는다.
 */

const QUOTED_IDENT_KEY_RE = /"([A-Za-z_$][\w$]*)"(\s*:)/g;

export function formatZodCode(code: string): string {
  const source = code.replace(QUOTED_IDENT_KEY_RE, "$1$2").trim();

  let out = "";
  let depth = 0;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let skipSpaces = false;

  const newline = () => {
    out = out.trimEnd();
    out += `\n${"  ".repeat(depth)}`;
    skipSpaces = true;
  };

  for (const ch of source) {
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      skipSpaces = false;
      continue;
    }
    if (skipSpaces && (ch === " " || ch === "\t")) continue;
    skipSpaces = false;

    if (ch === "{" || ch === "(" || ch === "[") {
      stack.push(ch);
      out += ch;
      if (ch === "{") {
        depth++;
        newline();
      }
      continue;
    }
    if (ch === "}" || ch === ")" || ch === "]") {
      const opener = stack.pop();
      if (ch === "}" && opener === "{") {
        depth = Math.max(0, depth - 1);
        newline();
      }
      out += ch;
      continue;
    }
    if (ch === "," && stack.at(-1) === "{") {
      out += ch;
      newline();
      continue;
    }
    out += ch;
  }
  return out;
}
