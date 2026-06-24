import { describe, expect, it } from "vitest";

import { calculateCostUsd, getModelCosts } from "./model-cost";

describe("calculateCostUsd", () => {
  it("Anthropic cache read/write 를 전체 입력에서 분리해 각각 단가를 적용한다", () => {
    const cost = calculateCostUsd("claude-sonnet-4-6", {
      inputTokens: 1_917,
      outputTokens: 161,
      cachedInputTokens: 1_024,
      cacheCreationInputTokens: 0,
    });

    expect(cost).toBeCloseTo(0.0054012, 10);
  });

  it("Anthropic cache creation 은 Claude Code 기본인 5분 write 단가를 적용한다", () => {
    const cost = calculateCostUsd("claude-sonnet-4-6", {
      inputTokens: 1_992,
      outputTokens: 187,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 1_068,
    });

    expect(cost).toBeCloseTo(0.009582, 10);
  });

  it("legacy/원시 Anthropic usage 처럼 cache 가 input 보다 커도 음수 비용을 만들지 않는다", () => {
    const cost = calculateCostUsd("claude-sonnet-4-6", {
      inputTokens: 893,
      outputTokens: 161,
      cachedInputTokens: 1_024,
      cacheCreationInputTokens: 0,
    });

    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeCloseTo(0.0027222, 10);
  });

  it("[1m] suffix 는 cost lookup 에서 strip 하고 long-context 할증은 붙이지 않는다", () => {
    const base = getModelCosts("claude-sonnet-4-6");
    const suffixed = getModelCosts("claude-sonnet-4-6[1m]");
    expect(suffixed).toBe(base);
    expect(suffixed.longContext).toBeUndefined();

    const usage = {
      inputTokens: 250_000,
      outputTokens: 1_000,
      cachedInputTokens: 200_000,
      cacheCreationInputTokens: 0,
    };
    expect(calculateCostUsd("claude-sonnet-4-6[1m]", usage)).toBeCloseTo(
      calculateCostUsd("claude-sonnet-4-6", usage),
      10,
    );
  });
});
