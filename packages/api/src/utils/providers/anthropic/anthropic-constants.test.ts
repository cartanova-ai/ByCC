import { describe, expect, it } from "vitest";

import {
  ANTHROPIC_DEFAULT_MODEL,
  assertSupportedOneMillionSuffix,
  canonicalAnthropicModel,
  hasOneMillionSuffix,
  needsCli1mSuffix,
  supports1MContext,
} from "./anthropic-constants";

describe("canonicalAnthropicModel", () => {
  it("미지정이면 default model", () => {
    expect(canonicalAnthropicModel()).toBe(ANTHROPIC_DEFAULT_MODEL);
  });

  it("provider prefix 를 제거한다", () => {
    expect(canonicalAnthropicModel("anthropic/claude-opus-4-8")).toBe("claude-opus-4-8");
  });

  it("[1m] suffix 를 base canonical 에서 제거한다", () => {
    expect(canonicalAnthropicModel("claude-sonnet-4-6[1m]")).toBe("claude-sonnet-4-6");
    expect(canonicalAnthropicModel("anthropic/claude-sonnet-4-6[1m]")).toBe("claude-sonnet-4-6");
  });
});

describe("Anthropic 1M context policy", () => {
  it("지원 모델은 실측 확인된 exact set 만 true", () => {
    expect(supports1MContext("claude-sonnet-4-6")).toBe(true);
    expect(supports1MContext("claude-opus-4-6")).toBe(true);
    expect(supports1MContext("claude-opus-4-8")).toBe(true);

    expect(supports1MContext("claude-opus-4-7")).toBe(false);
    expect(supports1MContext("claude-sonnet-4-5")).toBe(false);
    expect(supports1MContext("claude-sonnet-4")).toBe(false);
    expect(supports1MContext("claude-haiku-4-5")).toBe(false);
  });

  it("CLI suffix 필요 모델과 기본 1M 모델을 분리한다", () => {
    expect(needsCli1mSuffix("claude-sonnet-4-6")).toBe(true);
    expect(needsCli1mSuffix("claude-opus-4-6")).toBe(true);
    expect(needsCli1mSuffix("claude-opus-4-8")).toBe(false);
    expect(needsCli1mSuffix("claude-opus-4-7")).toBe(false);
  });

  it("provider prefix 와 [1m] suffix 가 묻어도 base 기준으로 판별한다", () => {
    expect(supports1MContext("anthropic/claude-sonnet-4-6[1m]")).toBe(true);
    expect(needsCli1mSuffix("anthropic/claude-sonnet-4-6[1m]")).toBe(true);
    expect(supports1MContext("anthropic/claude-opus-4-8[1m]")).toBe(true);
    expect(needsCli1mSuffix("anthropic/claude-opus-4-8[1m]")).toBe(false);
  });

  it("unsupported alias + [1m] 은 조용히 다운그레이드하지 않는다", () => {
    expect(hasOneMillionSuffix("sonnet[1m]")).toBe(true);
    expect(() => assertSupportedOneMillionSuffix("sonnet[1m]")).toThrow(
      /Unsupported Anthropic 1M model suffix/,
    );
    expect(() => assertSupportedOneMillionSuffix("anthropic/claude-sonnet-4-6[1m]")).not.toThrow();
  });
});
