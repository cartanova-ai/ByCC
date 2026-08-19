import { describe, expect, it } from "vitest";

import {
  chatConfigChanged,
  chatTokenOptions,
  providerTokenMissing,
  resolvedTokenName,
  tokenTargetPayload,
} from "./chat-token-selection";

function token(
  name: string,
  provider: string,
  active: boolean,
  ord: number,
) {
  return { name, provider, active, ord };
}

describe("qgrid_chat token selection", () => {
  it("선택 모델과 같은 provider의 활성 토큰만 순서대로 보여준다", () => {
    const tokens = [
      token("anthropic/b", "anthropic", true, 2),
      token("openai/a", "openai", true, 0),
      token("anthropic/off", "anthropic", false, 0),
      token("anthropic/a", "anthropic", true, 1),
    ];

    expect(chatTokenOptions(tokens, "anthropic").map((entry) => entry.name)).toEqual([
      "anthropic/a",
      "anthropic/b",
    ]);
  });

  it("토큰이 바뀌면 기존 thread 좌표를 재사용하지 않도록 설정 변경으로 본다", () => {
    const previous = {
      model: "anthropic/claude-sonnet-4-6",
      system: "system",
      tokenName: "anthropic/a",
    };

    expect(chatConfigChanged(previous, { ...previous, tokenName: "anthropic/b" })).toBe(true);
    expect(chatConfigChanged(previous, { ...previous })).toBe(false);
  });

  it("자동 분배는 tokenName을 생략하고 지정 선택만 payload에 싣는다", () => {
    expect(tokenTargetPayload("")).toEqual({});
    expect(tokenTargetPayload("openai/a")).toEqual({ tokenName: "openai/a" });
  });

  it("토큰 없음 상태도 같은 활성 토큰 목록에서 판단한다", () => {
    const tokens = [
      token("openai/a", "openai", true, 0),
      token("anthropic/off", "anthropic", false, 0),
    ];

    expect(providerTokenMissing(tokens, "openai")).toBe(false);
    expect(providerTokenMissing(tokens, "anthropic")).toBe(true);
  });

  it("토큰 목록 로딩 중에는 선택을 보존하고 로딩 후 사라진 토큰만 해제한다", () => {
    const options = [token("openai/a", "openai", true, 0)];

    expect(resolvedTokenName("openai/a", [], false)).toBe("openai/a");
    expect(resolvedTokenName("openai/a", options, true)).toBe("openai/a");
    expect(resolvedTokenName("openai/missing", options, true)).toBe("");
  });
});
