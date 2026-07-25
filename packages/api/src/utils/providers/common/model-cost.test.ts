import { describe, expect, it } from "vitest";

import { calculateCostUsd, getModelCosts } from "./model-cost";

describe("calculateCostUsd", () => {
  it.each([
    ["gpt-5.6-sol", 5, 30, 0.5, 6.25],
    ["gpt-5.6-terra", 2.5, 15, 0.25, 3.125],
    ["gpt-5.6-luna", 1, 6, 0.1, 1.25],
    ["gpt-5.5", 5, 30, 0.5, undefined],
    ["gpt-5.4", 2.5, 15, 0.25, undefined],
    ["gpt-5.4-mini", 0.75, 4.5, 0.075, undefined],
    ["gpt-5.3-codex", 1.75, 14, 0.175, undefined],
    ["gpt-5.2", 1.75, 14, 0.175, undefined],
  ])(
    "%s official OpenAI rates",
    (model, inputTokens, outputTokens, cachedInputTokens, cacheCreationInputTokens) => {
      expect(getModelCosts(model)).toEqual(
        expect.objectContaining({
          inputTokens,
          outputTokens,
          cachedInputTokens,
          ...(cacheCreationInputTokens === undefined ? {} : { cacheCreationInputTokens }),
        }),
      );
      if (cacheCreationInputTokens === undefined) {
        expect(getModelCosts(model).cacheCreationInputTokens).toBeUndefined();
      }
    },
  );

  it.each([
    ["claude-fable-5", 10, 50, 1, 20],
    ["claude-haiku-4-5", 1, 5, 0.1, 2],
    ["claude-sonnet-4", 3, 15, 0.3, 6],
    ["claude-sonnet-4-5", 3, 15, 0.3, 6],
    ["claude-sonnet-4-6", 3, 15, 0.3, 6],
    ["claude-sonnet-4-7", 3, 15, 0.3, 6],
    ["claude-opus-4", 15, 75, 1.5, 30],
    ["claude-opus-4-1", 15, 75, 1.5, 30],
    ["claude-opus-4-5", 5, 25, 0.5, 10],
    ["claude-opus-4-6", 5, 25, 0.5, 10],
    ["claude-opus-4-7", 5, 25, 0.5, 10],
    ["claude-opus-4-8", 5, 25, 0.5, 10],
    ["claude-opus-5", 5, 25, 0.5, 10],
  ])(
    "%s official Anthropic rates for 5m/1h cache writes",
    (model, inputTokens, outputTokens, cachedInputTokens, cacheCreationInputTokens) => {
      expect(getModelCosts(model)).toMatchObject({
        inputTokens,
        outputTokens,
        cachedInputTokens,
        cacheCreationInputTokens,
        cacheCreationInputTokens5m: inputTokens * 1.25,
        cacheCreationInputTokens1h: inputTokens * 2,
      });
    },
  );

  it("Claude Sonnet 5 introductory pricing switches to standard pricing on 2026-09-01", () => {
    expect(getModelCosts("claude-sonnet-5", Date.UTC(2026, 7, 31))).toEqual({
      inputTokens: 2,
      outputTokens: 10,
      cachedInputTokens: 0.2,
      cacheCreationInputTokens: 4,
      cacheCreationInputTokens5m: 2.5,
      cacheCreationInputTokens1h: 4,
    });
    expect(getModelCosts("claude-sonnet-5", Date.UTC(2026, 8, 1))).toEqual({
      inputTokens: 3,
      outputTokens: 15,
      cachedInputTokens: 0.3,
      cacheCreationInputTokens: 6,
      cacheCreationInputTokens5m: 3.75,
      cacheCreationInputTokens1h: 6,
    });
  });

  it("provider prefix 와 [1m] suffix 를 제거한 canonical model 로 가격을 찾는다", () => {
    expect(getModelCosts("anthropic/claude-fable-5")).toBe(getModelCosts("claude-fable-5"));
    expect(getModelCosts("anthropic/claude-sonnet-4-6[1m]")).toBe(
      getModelCosts("claude-sonnet-4-6"),
    );
    expect(getModelCosts("openai/gpt-5.6-sol")).toBe(getModelCosts("gpt-5.6-sol"));
  });

  it.each([
    ["gpt-5.6-sol", 5, 30, 0.5, 6.25, 3.30625],
    ["gpt-5.6-terra", 2.5, 15, 0.25, 3.125, 1.653125],
    ["gpt-5.6-luna", 1, 6, 0.1, 1.25, 0.66125],
  ])(
    "%s applies published input, output, cache-read, and cache-write pricing",
    (model, inputTokens, outputTokens, cachedInputTokens, cacheCreationInputTokens, expectedCost) => {
      expect(getModelCosts(model)).toMatchObject({
        inputTokens,
        outputTokens,
        cachedInputTokens,
        cacheCreationInputTokens,
      });

      expect(
        calculateCostUsd(model, {
          inputTokens: 100_000,
          outputTokens: 100_000,
          cachedInputTokens: 50_000,
          cacheCreationInputTokens: 25_000,
        }),
      ).toBeCloseTo(expectedCost, 10);
    },
  );

  it.each([
    ["gpt-5.6-sol", 1.245],
    ["gpt-5.6-terra", 0.6225],
    ["gpt-5.6-luna", 0.249],
  ])("%s applies the published long-context surcharge", (model, expectedCost) => {
    expect(
      calculateCostUsd(model, {
        inputTokens: 300_000,
        outputTokens: 1_000,
        cachedInputTokens: 200_000,
      }),
    ).toBeCloseTo(expectedCost, 10);
  });

  it.each([
    ["gpt-5.6-sol", 1.37],
    ["gpt-5.6-terra", 0.685],
    ["gpt-5.6-luna", 0.274],
  ])("%s applies the long-context input multiplier to cache writes", (model, expectedCost) => {
    expect(
      calculateCostUsd(model, {
        inputTokens: 300_000,
        outputTokens: 1_000,
        cachedInputTokens: 200_000,
        cacheCreationInputTokens: 50_000,
      }),
    ).toBeCloseTo(expectedCost, 10);
  });

  it("Anthropic cache read/write 를 전체 입력에서 분리해 각각 단가를 적용한다", () => {
    const cost = calculateCostUsd("claude-sonnet-4-6", {
      inputTokens: 1_917,
      outputTokens: 161,
      cachedInputTokens: 1_024,
      cacheCreationInputTokens: 0,
    });

    expect(cost).toBeCloseTo(0.0054012, 10);
  });

  it("Anthropic cache creation 은 subscription Claude Code 기본인 1시간 write 단가를 적용한다", () => {
    const cost = calculateCostUsd("claude-sonnet-4-6", {
      inputTokens: 1_992,
      outputTokens: 187,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 1_068,
    });

    expect(cost).toBeCloseTo(0.011985, 10);
  });

  it("Anthropic cache creation 의 5분/1시간 token breakdown 을 각각 계산한다", () => {
    const cost = calculateCostUsd("claude-sonnet-4-6", {
      inputTokens: 100_000,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 80_000,
      cacheCreationInputTokens5m: 30_000,
      cacheCreationInputTokens1h: 50_000,
    });

    expect(cost).toBeCloseTo(0.4725, 10);
  });

  it("Fable input/output/cache read/1h cache write 단가를 각각 적용한다", () => {
    expect(
      calculateCostUsd("claude-fable-5", {
        inputTokens: 100_000,
        outputTokens: 100_000,
        cachedInputTokens: 50_000,
        cacheCreationInputTokens: 25_000,
      }),
    ).toBeCloseTo(5.8, 10);
  });

  it("Fable 의 5분/1시간 cache write 단가도 구분한다", () => {
    expect(
      calculateCostUsd("claude-fable-5", {
        inputTokens: 100_000,
        outputTokens: 100_000,
        cachedInputTokens: 50_000,
        cacheCreationInputTokens: 25_000,
        cacheCreationInputTokens5m: 10_000,
        cacheCreationInputTokens1h: 15_000,
      }),
    ).toBeCloseTo(5.725, 10);
  });

  it("Sonnet 5 introductory/standard 단가 전환을 cost 계산에도 적용한다", () => {
    const usage = {
      inputTokens: 100_000,
      outputTokens: 100_000,
      cachedInputTokens: 50_000,
      cacheCreationInputTokens: 25_000,
    };
    expect(calculateCostUsd("claude-sonnet-5", usage, Date.UTC(2026, 7, 31))).toBeCloseTo(
      1.16,
      10,
    );
    expect(calculateCostUsd("claude-sonnet-5", usage, Date.UTC(2026, 8, 1))).toBeCloseTo(
      1.74,
      10,
    );
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
