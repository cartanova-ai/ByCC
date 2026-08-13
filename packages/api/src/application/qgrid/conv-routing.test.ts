import { describe, expect, it } from "vitest";

import { decideConvRouting, systemHash } from "./conv-routing";
import { type QueryInput } from "./qgrid.types";

function input(overrides: Partial<QueryInput> = {}): QueryInput {
  return {
    prompt: "hello",
    ...overrides,
  };
}

describe("decideConvRouting", () => {
  it("일반 cold 첫 turn 은 기존 prompt 를 실행 input 으로 유지한다", () => {
    const decision = decideConvRouting(input({ prompt: "first turn" }));

    expect(decision.reuse).toBeUndefined();
    expect(decision.reuseInput).toBeUndefined();
    expect(decision.coldInput).toEqual([{ type: "text", text: "first turn", text_elements: [] }]);
  });

  it("tool result follow-up cold fallback 도 continuation 을 실행 input 으로 담는다", () => {
    const decision = decideConvRouting(
      input({
        prompt: "",
        history: JSON.stringify([
          {
            type: "function_call",
            name: "getWeather",
            arguments: '{"city":"Seoul"}',
            call_id: "call_1",
          },
          {
            type: "function_call_output",
            call_id: "call_1",
            output: "22C and clear",
          },
        ]),
        toolResults: [
          {
            toolCallId: "call_1",
            toolName: "getWeather",
            output: "22C and clear",
          },
        ],
      }),
    );

    expect(decision.reuse).toBeUndefined();
    expect(decision.coldHistory).toHaveLength(2);
    expect(decision.coldInput).toEqual([
      {
        type: "text",
        text: "Tool result for call call_1 (getWeather): 22C and clear\n\nNow continue answering the user's request using these results.",
        text_elements: [],
      },
    ]);
  });

  it("input 이미지가 있으면 prompt 문자열 대신 multimodal input 을 실행 input 으로 쓴다", () => {
    const decision = decideConvRouting(
      input({
        prompt: "use this as reference",
        input: [
          { type: "text", text: "use this as reference", text_elements: [] },
          { type: "image", url: "data:image/png;base64,iVBORw0KGgoBAgM" },
        ],
      }),
    );

    expect(decision.coldInput).toEqual([
      { type: "text", text: "use this as reference", text_elements: [] },
      { type: "image", url: "data:image/png;base64,iVBORw0KGgoBAgM" },
    ]);
  });

  it("텍스트 없는 이미지 input 은 prompt 를 실행 input 앞에 보존한다", () => {
    const decision = decideConvRouting(
      input({
        prompt: "use this as reference",
        input: [{ type: "image", url: "data:image/png;base64,iVBORw0KGgoBAgM" }],
      }),
    );

    expect(decision.coldInput).toEqual([
      { type: "text", text: "use this as reference", text_elements: [] },
      { type: "image", url: "data:image/png;base64,iVBORw0KGgoBAgM" },
    ]);
  });

  it("reuse 가능한 tool result follow-up 은 reuseInput 과 coldInput 이 같은 continuation 을 쓴다", () => {
    const decision = decideConvRouting(
      input({
        prompt: "",
        system: "same",
        runContext: {
          threadCoord: {
            workerId: 1,
            threadId: "S1",
            epoch: 0,
            systemHash: systemHash("same"),
          },
        },
        toolResults: [{ toolCallId: "call_1", output: "ok" }],
      }),
    );

    expect(decision.reuse).toEqual({ workerId: 1, threadId: "S1", epoch: 0 });
    expect(decision.reuseInput).toEqual(decision.coldInput);
    expect(decision.coldInput[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Tool result for call call_1"),
    });
    expect(decision.coldInput[0]).not.toMatchObject({ type: "text", text: "" });
  });

  it("direct OpenAI는 epoch=-1 좌표를 opaque cache affinity로 해석하고 전체 history를 유지한다", () => {
    const cacheAffinityKey = "a".repeat(64);
    const model = "openai/gpt-5.5";
    const decision = decideConvRouting(
      input({
        prompt: "next",
        model,
        system: "same",
        history: JSON.stringify([{ role: "user", content: "first" }]),
        cacheAffinityKey,
        runContext: {
          threadCoord: {
            workerId: 17,
            threadId: cacheAffinityKey,
            epoch: -1,
            systemHash: systemHash("same", model),
          },
        },
      }),
      { directOpenAI: true, modelNamespace: model },
    );

    expect(decision.reuse).toBeUndefined();
    expect(decision.reuseInput).toBeUndefined();
    expect(decision.coldHistory).toEqual([{ role: "user", content: "first" }]);
    expect(decision.coldInput).toEqual([{ type: "text", text: "next", text_elements: [] }]);
    expect(decision.promptCacheKey).toBe(cacheAffinityKey);
    expect(decision.preferredTokenId).toBe(17);
  });

  it("direct OpenAI rejects legacy or mismatched coords but keeps the request affinity key", () => {
    const cacheAffinityKey = "b".repeat(64);
    const decision = decideConvRouting(
      input({
        model: "openai/gpt-5.5",
        cacheAffinityKey,
        runContext: {
          threadCoord: {
            workerId: 4,
            threadId: "legacy-thread",
            epoch: 3,
            systemHash: systemHash(undefined, "openai/gpt-5.5"),
          },
        },
      }),
      { directOpenAI: true, modelNamespace: "openai/gpt-5.5" },
    );

    expect(decision.promptCacheKey).toBe(cacheAffinityKey);
    expect(decision.preferredTokenId).toBeUndefined();
    expect(decision.reuse).toBeUndefined();
  });

  it("system hash separates model namespaces", () => {
    expect(systemHash("same", "openai/gpt-5.5")).not.toBe(systemHash("same", "openai/gpt-5.4"));
  });

  it("direct OpenAI 요청에 affinity key 가 없으면 cache key 를 만들지 않는다", () => {
    const decision = decideConvRouting(input({ model: "openai/gpt-5.5" }), {
      directOpenAI: true,
      modelNamespace: "openai/gpt-5.5",
    });

    expect(decision.promptCacheKey).toBeUndefined();
    expect(decision.preferredTokenId).toBeUndefined();
  });
});
