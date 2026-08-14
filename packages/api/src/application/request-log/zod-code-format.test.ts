import { describe, expect, it } from "vitest";

import { formatZodCode } from "./zod-code-format";

describe("formatZodCode", () => {
  it("breaks object members onto lines and unquotes identifier keys", () => {
    const code =
      'z.object({ "dish": z.string().describe("추천 점심 메뉴"), "sides": z.array(z.object({ "name": z.string() })).max(3) })';
    expect(formatZodCode(code)).toBe(
      [
        "z.object({",
        '  dish: z.string().describe("추천 점심 메뉴"),',
        "  sides: z.array(z.object({",
        "    name: z.string()",
        "  })).max(3)",
        "})",
      ].join("\n"),
    );
  });

  it("keeps arrays, arguments, and chains inline", () => {
    expect(formatZodCode('z.enum(["a", "b"]).describe("x, y")')).toBe(
      'z.enum(["a", "b"]).describe("x, y")',
    );
  });

  it("never touches string literal content", () => {
    const code = 'z.object({ "note": z.string().describe("중괄호 { 와 , 쉼표 \\" 포함") })';
    expect(formatZodCode(code)).toContain('describe("중괄호 { 와 , 쉼표 \\" 포함")');
  });
});
