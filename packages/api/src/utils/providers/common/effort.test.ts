import { describe, expect, it } from "vitest";

import {
  ANTHROPIC_EFFORTS,
  OPENAI_EFFORTS,
  resolveAnthropicEffort,
  resolveOpenAIEffort,
} from "./effort";

describe("resolveOpenAIEffort", () => {
  it("Codex 카탈로그 어휘는 그대로 통과한다", () => {
    for (const effort of ["low", "medium", "high", "xhigh"]) {
      expect(resolveOpenAIEffort("gpt-5.5", effort)).toBe(effort);
    }
    expect(resolveOpenAIEffort("gpt-5.6-terra", "max")).toBe("max");
    expect(resolveOpenAIEffort("gpt-5.6-terra", "ultra")).toBe("ultra");
    expect(resolveOpenAIEffort("gpt-5.6-luna", "max")).toBe("max");
  });

  it("공개 API 어휘(none/minimal)와 다른 provider 어휘, 오타는 조용히 미지정으로 바꾼다", () => {
    expect(resolveOpenAIEffort("gpt-5.6-terra", "none")).toBeUndefined();
    expect(resolveOpenAIEffort("gpt-5.6-terra", "minimal")).toBeUndefined();
    expect(resolveOpenAIEffort("gpt-5.6-terra", "hgih")).toBeUndefined();
    expect(resolveOpenAIEffort("gpt-5.6-terra", undefined)).toBeUndefined();
  });

  it("모델 상한을 넘는 값은 클램프하지 않고 미지정으로 바꾼다", () => {
    expect(resolveOpenAIEffort("gpt-5.5", "max")).toBeUndefined();
    expect(resolveOpenAIEffort("gpt-5.4", "ultra")).toBeUndefined();
    expect(resolveOpenAIEffort("gpt-5.6-luna", "ultra")).toBeUndefined();
    expect(resolveOpenAIEffort("gpt-5.3-codex-spark", "xhigh")).toBe("xhigh");
  });

  it("어휘 순서가 클램프 판정의 기준이다", () => {
    expect([...OPENAI_EFFORTS]).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect([...ANTHROPIC_EFFORTS]).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
});

describe("resolveAnthropicEffort", () => {
  it("Claude Code --effort 허용값은 그대로 통과한다", () => {
    for (const effort of ANTHROPIC_EFFORTS) {
      expect(resolveAnthropicEffort(effort)).toBe(effort);
    }
  });

  it("OpenAI 전용 값과 모르는 값은 조용히 미지정으로 바꿔 qgrid 기본(low)이 적용되게 한다", () => {
    expect(resolveAnthropicEffort("ultra")).toBeUndefined();
    expect(resolveAnthropicEffort("none")).toBeUndefined();
    expect(resolveAnthropicEffort("minimal")).toBeUndefined();
    expect(resolveAnthropicEffort(undefined)).toBeUndefined();
  });
});
