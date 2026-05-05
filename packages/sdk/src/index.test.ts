import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { Output, QgridError, generateText, queryQgrid } from "./index";

// --- Mock 서버 ---

const MOCK_USAGE = {
  input_tokens: 100,
  output_tokens: 50,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 80,
};

const server = setupServer(
  http.post("http://localhost:44900/api/qgrid/query", async ({ request }) => {
    const body = (await request.json()) as {
      prompt: string;
      system?: string;
      jsonSchema?: string;
    };

    // 특수 프롬프트로 에러 시나리오 테스트
    if (body.prompt === "__error_429__") {
      return HttpResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
    }
    if (body.prompt === "__error_503__") {
      return HttpResponse.json({ error: "Server unavailable" }, { status: 503 });
    }
    if (body.prompt === "__error_500__") {
      return HttpResponse.json({ error: "Internal error" }, { status: 500 });
    }
    if (body.prompt === "__invalid_json__") {
      return HttpResponse.json({
        text: "not valid json {[",
        usage: MOCK_USAGE,
        durationMs: 100,
        costUsd: 0.01,
      });
    }

    // jsonSchema 가 body 에 오면 structured output 모의 (JSON-encoded 문자열)
    if (body.jsonSchema) {
      return HttpResponse.json({
        text: JSON.stringify({ questions: ["Q1", "Q2", "Q3"] }),
        usage: MOCK_USAGE,
        durationMs: 200,
        costUsd: 0.02,
      });
    }

    return HttpResponse.json({
      text: `Echo: ${body.prompt}`,
      usage: MOCK_USAGE,
      durationMs: 150,
      costUsd: 0.015,
    });
  }),
);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// --- queryQgrid (기존 API 리네이밍) ---

describe("queryQgrid", () => {
  it("기본 텍스트 응답", async () => {
    const result = await queryQgrid({ prompt: "Hello" });

    expect(result.data).toBe("Echo: Hello");
    expect(result.usage.input_tokens).toBe(100);
    expect(result.usage.output_tokens).toBe(50);
    expect(result.durationMs).toBe(150);
    expect(result.costUsd).toBe(0.015);
  });

  it("returnType으로 구조화 응답", async () => {
    const schema = z.object({ questions: z.array(z.string()) });
    const result = await queryQgrid({
      prompt: "질문 생성",
      system: "질문 생성기",
      returnType: schema,
    });

    expect(result.data).toEqual({ questions: ["Q1", "Q2", "Q3"] });
  });

  it("429 에러 시 QUOTA_EXHAUSTED", async () => {
    await expect(queryQgrid({ prompt: "__error_429__" })).rejects.toThrow(QgridError);
    await expect(queryQgrid({ prompt: "__error_429__" })).rejects.toMatchObject({
      code: "QUOTA_EXHAUSTED",
      status: 429,
    });
  });

  it("503 에러 시 SERVER_UNAVAILABLE", async () => {
    await expect(queryQgrid({ prompt: "__error_503__" })).rejects.toMatchObject({
      code: "SERVER_UNAVAILABLE",
      status: 503,
    });
  });

  it("기타 에러 시 REQUEST_FAILED", async () => {
    await expect(queryQgrid({ prompt: "__error_500__" })).rejects.toMatchObject({
      code: "REQUEST_FAILED",
      status: 500,
    });
  });

  it("JSON 파싱 실패 시 PARSE_FAILED", async () => {
    const schema = z.object({ name: z.string() });
    await expect(
      queryQgrid({ prompt: "__invalid_json__", returnType: schema }),
    ).rejects.toMatchObject({
      code: "PARSE_FAILED",
      status: 200,
    });
  });
});

// --- generateText (ai-sdk 호환) ---
describe("generateText", () => {
  describe("prompt 기반 호출", () => {
    it("기본 텍스트 응답", async () => {
      const result = await generateText({ prompt: "Hello" });

      expect(result.text).toBe("Echo: Hello");
      expect(result.finishReason).toBe("stop");
      expect(result.output).toBe("Echo: Hello");
    });

    it("usage가 camelCase로 매핑됨 (cache 포함)", async () => {
      const { usage } = await generateText({ prompt: "Hello" });

      expect(usage.inputTokens).toBe(100);
      expect(usage.outputTokens).toBe(50);
      expect(usage.totalTokens).toBe(150);
      expect(usage.inputTokenDetails.cacheReadTokens).toBe(80);
      expect(usage.inputTokenDetails.cacheWriteTokens).toBe(0);
    });

    it("system 파라미터 전달", async () => {
      const result = await generateText({
        prompt: "Hello",
        system: "Be brief.",
      });

      expect(result.text).toBe("Echo: Hello");
    });
  });

  describe("구조화 출력 (Output.object)", () => {
    it("Output.object로 스키마 전달", async () => {
      const schema = z.object({ questions: z.array(z.string()) });
      const result = await generateText({
        prompt: "질문 생성",
        system: "질문 생성기",
        output: Output.object({ schema }),
      });

      expect(result.output).toEqual({ questions: ["Q1", "Q2", "Q3"] });
      expect(result.text).toBe(JSON.stringify({ questions: ["Q1", "Q2", "Q3"] }));
    });
  });

  describe("ai-sdk 호환 파라미터 무시", () => {
    it("model과 providerOptions를 전달해도 정상 동작", async () => {
      const result = await generateText({
        model: "anthropic/claude-haiku-4.5",
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
        prompt: "Hello",
      });

      expect(result.text).toBe("Echo: Hello");
    });
  });
});

// --- Output 헬퍼 ---

describe("Output", () => {
  it("Output.object가 올바른 OutputDefinition 반환", () => {
    const schema = z.object({ name: z.string() });
    const def = Output.object({ schema });

    expect(def.type).toBe("object");
    expect(def.schema).toBe(schema);
  });
});

// --- QgridError ---

describe("QgridError", () => {
  it("code, status, message 포함", () => {
    const err = new QgridError("TEST_CODE", 400, "Test message");

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(QgridError);
    expect(err.code).toBe("TEST_CODE");
    expect(err.status).toBe(400);
    expect(err.message).toBe("Test message");
    expect(err.name).toBe("QgridError");
  });
});
