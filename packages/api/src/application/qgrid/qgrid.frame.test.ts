import { EventEmitter } from "node:events";

import { Sonamu } from "sonamu";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { QgridFrame } from "./qgrid.frame";
import { QueryInput } from "./qgrid.types";

const {
  findOneMock,
  findManyMock,
  findActiveByProviderAndNameMock,
  saveMock,
  updateFieldsMock,
  requestLogSaveMock,
  requestLogCreateRunMock,
  appendStepMock,
  dispatcherQueryMock,
  dispatcherQueryStreamMock,
  beforeQueryMock,
  afterQueryMock,
  assertNativeRunAdmissionMock,
  finishRunWithErrorMock,
  finishRunAbortedMock,
  getRateLimitsByTokenIdMock,
} = vi.hoisted(() => {
  // isolate:false 공유 레지스트리 방어: 같은 fork 에서 앞선 파일이 request-log/token/
  // run-lifecycle 실모듈을 캐시해 두면 아래 vi.mock 들이 조용히 무시된다(실 DB 호출로
  // 폭발). import 보다 먼저 레지스트리를 비워 이 파일은 항상 mock 그래프로 시작한다.
  vi.resetModules();
  return {
    findOneMock: vi.fn(),
    findManyMock: vi.fn(),
    findActiveByProviderAndNameMock: vi.fn(),
    saveMock: vi.fn(),
    updateFieldsMock: vi.fn(),
    requestLogSaveMock: vi.fn(),
    requestLogCreateRunMock: vi.fn(),
    appendStepMock: vi.fn(),
    dispatcherQueryMock: vi.fn(),
    dispatcherQueryStreamMock: vi.fn(),
    beforeQueryMock: vi.fn(),
    afterQueryMock: vi.fn(),
    assertNativeRunAdmissionMock: vi.fn(),
    finishRunWithErrorMock: vi.fn(),
    finishRunAbortedMock: vi.fn(),
    getRateLimitsByTokenIdMock: vi.fn(),
  };
});

vi.mock("../request-log/request-log.model", () => ({
  MICRO_USD: 1_000_000,
  RequestLogModel: {
    save: requestLogSaveMock,
    createRun: requestLogCreateRunMock,
    appendStep: appendStepMock,
  },
}));

vi.mock("../token/token.model", () => ({
  TokenModel: {
    findOne: findOneMock,
    findMany: findManyMock,
    findActiveByProviderAndName: findActiveByProviderAndNameMock,
    save: saveMock,
    updateFields: updateFieldsMock,
  },
}));

// QgridFrame의 token-death 연결은 이 스위트의 관심사가 아니다. isolate:false 워커에서
// 부분 TokenModel mock으로 token-death 실제 모듈을 먼저 캐시하지 않도록 경계를 끊는다.
vi.mock("./token-death", () => ({
  deactivateAuthDeadToken: vi.fn(),
  notifyTokenAdded: vi.fn(),
}));

vi.mock("./qgrid.dispatcher", async (importOriginal) => {
  const original = await importOriginal<typeof import("./qgrid.dispatcher")>();
  return {
    ...original,
    QgridDispatcher: {
      query: dispatcherQueryMock,
      queryStream: dispatcherQueryStreamMock,
      openaiDispatcher: {
        getRateLimitsByTokenId: getRateLimitsByTokenIdMock,
      },
    },
  };
});

vi.mock("./qgrid-run-lifecycle", () => ({
  assertNativeRunAdmission: assertNativeRunAdmissionMock,
  beforeQuery: beforeQueryMock,
  afterQuery: afterQueryMock,
  finishRunWithError: finishRunWithErrorMock,
  finishRunAborted: finishRunAbortedMock,
}));

const tokenEntry = {
  id: 1,
  created_at: new Date("2026-06-30T00:00:00.000Z"),
  provider: "anthropic",
  credentials: {
    accessToken: "sk-ant-oat01-test",
    refreshToken: "sk-ant-ort01-test",
    expiresAt: Date.now() + 3_600_000,
    accountUuid: "acc-1",
  },
  name: "tok-A",
  active: true,
  ord: 0,
  quota_threshold: null,
  weight: 1,
};

function deeplyNestedInputSchema(depth: number): unknown {
  return JSON.parse(`${"[".repeat(depth)}0${"]".repeat(depth)}`) as unknown;
}

describe("QgridFrame.updateToken", () => {
  beforeEach(() => {
    findOneMock.mockReset();
    saveMock.mockReset();
    saveMock.mockResolvedValue([1]);
    updateFieldsMock.mockReset().mockResolvedValue(1);
    requestLogSaveMock.mockReset();
    requestLogSaveMock.mockResolvedValue([1]);
    appendStepMock.mockReset();
    appendStepMock.mockResolvedValue(1);
    dispatcherQueryMock.mockReset();
    findActiveByProviderAndNameMock.mockReset();
  });

  it("rejects quota thresholds outside bounds before updating", async () => {
    await expect(QgridFrame.updateToken(1, "tok-A", 0)).rejects.toThrow(
      "quotaThreshold must be an integer between 1 and 100, or null",
    );

    expect(updateFieldsMock).not.toHaveBeenCalled();
  });

  it("updates only the supplied quota threshold", async () => {
    await expect(QgridFrame.updateToken(1, "tok-A", 80)).resolves.toEqual({ updated: true });

    expect(updateFieldsMock).toHaveBeenCalledWith(1, {
      name: "tok-A",
      quota_threshold: 80,
    });
  });

  it("rejects invalid weights before updating", async () => {
    await expect(QgridFrame.updateToken(1, "tok-A", undefined, 0)).rejects.toThrow(
      "weight must be an integer between 1 and 100",
    );

    expect(updateFieldsMock).not.toHaveBeenCalled();
  });

  it("updates only the supplied weight", async () => {
    await expect(QgridFrame.updateToken(1, undefined, undefined, 4)).resolves.toEqual({
      updated: true,
    });

    expect(updateFieldsMock).toHaveBeenCalledWith(1, { weight: 4 });
  });

  it("reports a missing token from the atomic update result", async () => {
    updateFieldsMock.mockResolvedValueOnce(0);

    await expect(QgridFrame.updateToken(404, undefined, undefined, 4)).resolves.toEqual({
      updated: false,
    });
  });
});

describe("QgridFrame.query request logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    beforeQueryMock.mockReset().mockResolvedValue({ requestLogId: 41, stepIndex: 0 });
    afterQueryMock.mockReset().mockResolvedValue({});
    assertNativeRunAdmissionMock.mockReset();
    finishRunWithErrorMock.mockReset();
    dispatcherQueryMock.mockReset();
    findActiveByProviderAndNameMock.mockReset();
  });

  function queryOutput() {
    return {
      text: "hello",
      content: [{ type: "text", text: "hello" }],
      finishReason: "stop",
      tokenName: "tok-A",
      model: "gpt-5-codex",
      usage: {
        input_tokens: 5,
        output_tokens: 7,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      durationMs: 120,
      ttftMs: 39,
      costUsd: 0.001,
      costSource: "pricing_table",
      runContext: {
        threadCoord: {
          workerId: 1,
          threadId: "thread-1",
          epoch: 2,
          systemHash: "system-hash",
        },
      },
    };
  }

  it("creates a run before dispatch when logger is omitted", async () => {
    const order: string[] = [];
    beforeQueryMock.mockImplementationOnce(async () => {
      order.push("before");
      return { requestLogId: 41, stepIndex: 0 };
    });
    dispatcherQueryMock.mockImplementationOnce(async () => {
      order.push("dispatch");
      return queryOutput();
    });
    afterQueryMock.mockImplementationOnce(async () => {
      order.push("after");
      return {};
    });

    const args = { prompt: "hi", model: "openai/gpt-5-codex" };
    const result = await QgridFrame.query(args);

    expect(order).toEqual(["before", "dispatch", "after"]);
    expect(beforeQueryMock).toHaveBeenCalledWith(args);
    expect(afterQueryMock).toHaveBeenCalledWith(41, 0, args, expect.objectContaining({ text: "hello" }));
    expect(result.runContext).toEqual(queryOutput().runContext);
  });

  it("tokenName 을 활성 토큰 id 로 해석해 지정 요청으로 전달한다", async () => {
    findActiveByProviderAndNameMock.mockResolvedValueOnce({
      ...tokenEntry,
      id: 17,
      name: "anthropic/tok-A",
    });
    dispatcherQueryMock.mockResolvedValueOnce(queryOutput());

    await QgridFrame.query({
      prompt: "hi",
      model: "anthropic/claude-sonnet-4-6",
      tokenName: "anthropic/tok-A",
    });

    expect(findActiveByProviderAndNameMock).toHaveBeenCalledWith(
      "A",
      "anthropic",
      "anthropic/tok-A",
    );
    expect(dispatcherQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({ preferredTokenId: 17 }),
      expect.any(AbortSignal),
    );
  });

  it("tokenName 에 해당하는 활성 토큰이 없으면 대체 없이 실패한다", async () => {
    findActiveByProviderAndNameMock.mockResolvedValueOnce(undefined);

    await expect(
      QgridFrame.query({
        prompt: "hi",
        model: "anthropic/claude-sonnet-4-6",
        tokenName: "anthropic/missing",
      }),
    ).rejects.toThrow("Active token not found: anthropic/missing");

    expect(dispatcherQueryMock).not.toHaveBeenCalled();
    expect(beforeQueryMock).not.toHaveBeenCalled();
  });

  it("tokenName provider 와 model provider 가 다르면 조회 전에 실패한다", async () => {
    await expect(
      QgridFrame.query({
        prompt: "hi",
        model: "anthropic/claude-sonnet-4-6",
        tokenName: "openai/tok-A",
      }),
    ).rejects.toThrow("Token provider does not match model provider");

    expect(findActiveByProviderAndNameMock).not.toHaveBeenCalled();
    expect(dispatcherQueryMock).not.toHaveBeenCalled();
  });

  it("persists an immediate tools+schema structured answer as final JSON text", async () => {
    const output = {
      ...queryOutput(),
      text: '{"result":"ok"}',
      content: [{ type: "text" as const, text: '{"result":"ok"}' }],
    };
    dispatcherQueryMock.mockResolvedValueOnce(output);
    const args = {
      prompt: "answer",
      model: "openai/gpt-5.6-terra",
      tools: [{ name: "lookup", inputSchema: { type: "object" } }],
      jsonSchema: JSON.stringify({
        type: "object",
        properties: { result: { type: "string" } },
        required: ["result"],
      }),
    };

    await expect(QgridFrame.query(args)).resolves.toMatchObject({
      text: '{"result":"ok"}',
      content: [{ type: "text", text: '{"result":"ok"}' }],
      finishReason: "stop",
    });
    expect(beforeQueryMock).toHaveBeenCalledWith(args);
    expect(afterQueryMock).toHaveBeenCalledWith(41, 0, args, output);
    expect(finishRunWithErrorMock).not.toHaveBeenCalled();
  });

  it("does not create or update logs when logger is false", async () => {
    const output = queryOutput();
    dispatcherQueryMock.mockResolvedValueOnce(output);

    await expect(
      QgridFrame.query({ prompt: "hi", model: "openai/gpt-5-codex", logger: false }),
    ).resolves.toEqual(output);

    expect(beforeQueryMock).not.toHaveBeenCalled();
    expect(afterQueryMock).not.toHaveBeenCalled();
    expect(finishRunWithErrorMock).not.toHaveBeenCalled();
  });

  it("rejects logger-disabled native dispatch while restart admission is closed", async () => {
    assertNativeRunAdmissionMock.mockImplementationOnce(() => {
      throw Object.assign(new Error("server restarting"), { statusCode: 503 });
    });

    await expect(
      QgridFrame.query({ prompt: "hi", model: "openai/gpt-5-codex", logger: false }),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(dispatcherQueryMock).not.toHaveBeenCalled();
    expect(beforeQueryMock).not.toHaveBeenCalled();
  });

  it("merges a tool run id with the provider thread coordinate", async () => {
    dispatcherQueryMock.mockResolvedValueOnce(queryOutput());
    afterQueryMock.mockResolvedValueOnce({ runContext: { requestLogId: 41 } });

    const result = await QgridFrame.query({ prompt: "hi", model: "openai/gpt-5-codex" });

    expect(result.runContext).toEqual({
      requestLogId: 41,
      threadCoord: queryOutput().runContext.threadCoord,
    });
  });

  it("finishes the pre-created run when provider execution fails", async () => {
    dispatcherQueryMock.mockRejectedValueOnce(new Error("provider failed"));
    const args = { prompt: "hi", model: "openai/gpt-5-codex" };

    await expect(QgridFrame.query(args)).rejects.toThrow("provider failed");

    expect(finishRunWithErrorMock).toHaveBeenCalledWith(41, "provider failed", args);
  });

  it("marks an incoherent structured envelope failure as a request-log error", async () => {
    const error = new Error(
      "tool-call emulation: structured response envelope is missing required keys: toolCalls",
    );
    dispatcherQueryMock.mockRejectedValueOnce(error);
    const args = {
      prompt: "answer",
      model: "anthropic/claude-sonnet-4-6",
      tools: [{ name: "lookup", inputSchema: { type: "object" } }],
      jsonSchema: JSON.stringify({ type: "object", properties: {} }),
    };

    await expect(QgridFrame.query(args)).rejects.toThrow(error.message);
    expect(finishRunWithErrorMock).toHaveBeenCalledWith(41, error.message, args);
    expect(afterQueryMock).not.toHaveBeenCalled();
  });

  it("aborts provider execution and marks the run aborted when the HTTP response closes early", async () => {
    const requestRaw = Object.assign(new EventEmitter(), { aborted: false });
    const responseRaw = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
    });
    vi.spyOn(Sonamu, "getContext").mockReturnValue({
      transport: "http",
      request: { raw: requestRaw },
      reply: { raw: responseRaw },
    } as never);
    let providerSignal: AbortSignal | undefined;
    dispatcherQueryMock.mockImplementationOnce(
      (_args: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          providerSignal = signal;
          signal.addEventListener("abort", () => reject(new Error("provider aborted")), {
            once: true,
          });
        }),
    );
    const args = { prompt: "hi", model: "anthropic/claude-opus-5" };

    const queryPromise = QgridFrame.query(args);
    await vi.waitFor(() => expect(providerSignal).toBeDefined());
    responseRaw.destroyed = true;
    responseRaw.emit("close");

    await expect(queryPromise).rejects.toThrow("provider aborted");
    expect(providerSignal?.aborted).toBe(true);
    expect(finishRunAbortedMock).toHaveBeenCalledWith(41, args);
    expect(finishRunWithErrorMock).not.toHaveBeenCalled();
    expect(requestRaw.listenerCount("aborted")).toBe(0);
    expect(responseRaw.listenerCount("close")).toBe(0);
  });

  it("returns the provider result when afterQuery persistence fails", async () => {
    const output = queryOutput();
    dispatcherQueryMock.mockResolvedValueOnce(output);
    afterQueryMock.mockRejectedValueOnce(new Error("request log unavailable"));
    const args = { prompt: "hi", model: "openai/gpt-5-codex" };

    await expect(QgridFrame.query(args)).resolves.toBe(output);

    expect(finishRunWithErrorMock).toHaveBeenCalledWith(41, "request log unavailable", args);
  });

  it.each([
    ["malformed JSON", '{"type":"object"'],
    ["unsupported top-level array schema", '{"type":"array","items":{"type":"string"}}'],
  ])("returns a deterministic 400 before logging or dispatch for %s", async (_label, jsonSchema) => {
    await expect(
      QgridFrame.query({
        prompt: "hi",
        model: "openai/gpt-5.5",
        jsonSchema,
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("qgrid: jsonSchema"),
    });

    expect(beforeQueryMock).not.toHaveBeenCalled();
    expect(dispatcherQueryMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a deeply nested tools-only schema before logging or dispatch", async () => {
    await expect(
      QgridFrame.query({
        prompt: "hi",
        model: "openai/gpt-5.5",
        tools: [{ name: "deepTool", inputSchema: deeplyNestedInputSchema(256) }],
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("tools[0].inputSchema exceeds depth limit"),
    });

    expect(beforeQueryMock).not.toHaveBeenCalled();
    expect(dispatcherQueryMock).not.toHaveBeenCalled();
  });

  it("returns 400 for an unsupported composed-schema reference before logging or dispatch", async () => {
    await expect(
      QgridFrame.query({
        prompt: "hi",
        model: "openai/gpt-5.5",
        tools: [{ name: "lookup", inputSchema: { type: "object" } }],
        jsonSchema: JSON.stringify({
          $id: "urn:example:answer",
          type: "object",
          properties: { answer: { type: "string" } },
        }),
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("$id is not supported"),
    });

    expect(beforeQueryMock).not.toHaveBeenCalled();
    expect(dispatcherQueryMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed normalization keyword before logging or dispatch", async () => {
    await expect(
      QgridFrame.query({
        prompt: "hi",
        model: "openai/gpt-5.5",
        jsonSchema: JSON.stringify({
          type: "object",
          anyOf: {},
        }),
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("caller schema cannot be normalized"),
    });

    expect(beforeQueryMock).not.toHaveBeenCalled();
    expect(dispatcherQueryMock).not.toHaveBeenCalled();
  });

  it("returns 400 for an unrestricted positional tuple before logging or dispatch", async () => {
    await expect(
      QgridFrame.query({
        prompt: "hi",
        model: "openai/gpt-5.6-terra",
        jsonSchema: JSON.stringify({
          type: "object",
          properties: {
            tuple: {
              type: "array",
              items: [{ type: "string" }],
              additionalItems: true,
            },
          },
          required: ["tuple"],
        }),
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("unrestricted tuple rest is not supported"),
    });

    expect(beforeQueryMock).not.toHaveBeenCalled();
    expect(dispatcherQueryMock).not.toHaveBeenCalled();
  });

  // SON-532: anthropic 은 strictify 를 거치지 않으므로 strict 변환이 다루지 못하던 형태
  // (positional tuple 등)도 거절 사유가 아니다 — 원형 그대로 프롬프트에 안내된다.
  it.each([
    [
      "positional tuple",
      {
        type: "object",
        properties: {
          tuple: { type: "array", items: [{ type: "string" }, { type: "integer" }] },
        },
        required: ["tuple"],
      },
    ],
    [
      "tuple nested under not",
      { type: "object", not: { type: "array", items: [{ type: "string" }] } },
    ],
    [
      "prefixItems tuple with missing type",
      {
        type: "object",
        properties: { tuple: { prefixItems: [{ type: "string" }, { type: "integer" }] } },
        required: ["tuple"],
      },
    ],
    [
      "prefixItems tuple with nullable union type",
      {
        type: "object",
        properties: {
          tuple: {
            type: ["array", "null"],
            prefixItems: [{ type: "string" }, { type: "integer" }],
          },
        },
        required: ["tuple"],
      },
    ],
  ] as const)(
    "accepts an Anthropic schema with %s and proceeds to dispatch (SON-532)",
    async (_label, schema) => {
      beforeQueryMock.mockResolvedValueOnce({ requestLogId: 41, stepIndex: 0 });
      dispatcherQueryMock.mockResolvedValueOnce(queryOutput());
      afterQueryMock.mockResolvedValueOnce({});

      await expect(
        QgridFrame.query({
          prompt: "hi",
          model: "anthropic/claude-opus-4-8",
          jsonSchema: JSON.stringify(schema),
        }),
      ).resolves.toMatchObject({ text: "hello" });

      expect(dispatcherQueryMock).toHaveBeenCalledOnce();
    },
  );

  it("returns 400 for an OpenAI tuple under not instead of changing negative semantics", async () => {
    await expect(
      QgridFrame.query({
        prompt: "hi",
        model: "openai/gpt-5.6-terra",
        jsonSchema: JSON.stringify({
          type: "object",
          not: {
            type: "array",
            items: [{ type: "string" }],
          },
        }),
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining(
        "positional tuple schemas are not supported in this schema position",
      ),
    });

    expect(beforeQueryMock).not.toHaveBeenCalled();
    expect(dispatcherQueryMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a definition referenced under not before globally normalizing it", async () => {
    await expect(
      QgridFrame.query({
        prompt: "hi",
        model: "openai/gpt-5.6-terra",
        jsonSchema: JSON.stringify({
          type: "object",
          $defs: {
            Forbidden: {
              type: "object",
              properties: { value: { const: 0 } },
              required: ["value"],
            },
          },
          not: { $ref: "#/$defs/Forbidden" },
        }),
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining(
        "schema references are not supported in this schema position",
      ),
    });

    expect(beforeQueryMock).not.toHaveBeenCalled();
    expect(dispatcherQueryMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a literal JSON value",
      {
        type: "object",
        properties: {
          payload: { $ref: "#/$defs/Carrier/enum/0" },
        },
        required: ["payload"],
        $defs: {
          Carrier: {
            enum: [{ type: "object", properties: { value: { type: "string" } } }],
          },
        },
      },
      "$ref target must be the document root or a definition root",
    ],
    [
      "a conditional schema position",
      {
        type: "object",
        properties: {
          payload: { $ref: "#/if" },
        },
        required: ["payload"],
        if: {
          type: "object",
          properties: { secret: { type: "string" } },
        },
      },
      "$ref target must be the document root or a definition root",
    ],
  ] as const)(
    "returns 400 for an OpenAI ref targeting %s before logging or dispatch",
    async (_label, schema, message) => {
      await expect(
        QgridFrame.query({
          prompt: "hi",
          model: "openai/gpt-5.6-terra",
          jsonSchema: JSON.stringify(schema),
        }),
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining(message),
      });

      expect(beforeQueryMock).not.toHaveBeenCalled();
      expect(dispatcherQueryMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["missing", undefined],
    ["nullable union", ["array", "null"]],
  ] as const)(
    "returns 400 for an OpenAI positional tuple with %s type before logging or dispatch",
    async (_label, type) => {
      await expect(
        QgridFrame.query({
          prompt: "hi",
          model: "openai/gpt-5.6-terra",
          jsonSchema: JSON.stringify({
            type: "object",
            properties: {
              tuple: {
                ...(type === undefined ? {} : { type }),
                items: [{ type: "string" }, { type: "integer" }],
              },
            },
            required: ["tuple"],
          }),
        }),
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining(
          'positional tuple schemas must declare type "array"',
        ),
      });

      expect(beforeQueryMock).not.toHaveBeenCalled();
      expect(dispatcherQueryMock).not.toHaveBeenCalled();
    },
  );

  // SON-532: argv 64KiB 제한은 --json-schema 전용이었다. 프롬프트 전달은 system 크기
  // 분기(--system-prompt-file)가 흡수하므로 전역 복잡도 한도만 남는다.
  it("accepts an Anthropic schema that exceeds the old argv size limit (SON-532)", async () => {
    beforeQueryMock.mockResolvedValueOnce({ requestLogId: 41, stepIndex: 0 });
    dispatcherQueryMock.mockResolvedValueOnce(queryOutput());
    afterQueryMock.mockResolvedValueOnce({});

    await expect(
      QgridFrame.query({
        prompt: "hi",
        model: "anthropic/claude-sonnet-4-6",
        tools: [
          {
            name: "lookup",
            description: "x".repeat(64 * 1024),
            inputSchema: { type: "object" },
          },
        ],
        jsonSchema: JSON.stringify({
          type: "object",
          properties: { answer: { type: "string" } },
        }),
      }),
    ).resolves.toMatchObject({ text: "hello" });

    expect(dispatcherQueryMock).toHaveBeenCalledOnce();
  });

  it("accepts logger: false in the wire schema", () => {
    expect(QueryInput.safeParse({ prompt: "hi", logger: false }).success).toBe(true);
  });

  it("accepts bounded positive integer timeout values only", () => {
    expect(QueryInput.safeParse({ prompt: "hi", timeout: 360_000 }).success).toBe(true);
    expect(QueryInput.safeParse({ prompt: "hi", timeout: 0 }).success).toBe(false);
    expect(QueryInput.safeParse({ prompt: "hi", timeout: 1.5 }).success).toBe(false);
    expect(QueryInput.safeParse({ prompt: "hi", timeout: 1_800_001 }).success).toBe(false);
  });
});

describe("QgridFrame.prepareStream", () => {
  beforeEach(() => {
    dispatcherQueryMock.mockReset();
    requestLogSaveMock.mockReset();
  });

  it("rejects imageGeneration before creating an SSE stream", async () => {
    await expect(
      QgridFrame.prepareStream({
        prompt: "draw",
        model: "openai/gpt-5-codex",
        imageGeneration: true,
      }),
    ).rejects.toThrow(/imageGeneration is not supported with streaming/);

    expect(dispatcherQueryMock).not.toHaveBeenCalled();
    expect(requestLogSaveMock).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid schema before allocating a stream id", async () => {
    await expect(
      QgridFrame.prepareStream({
        prompt: "hi",
        model: "anthropic/claude-sonnet-4-6",
        jsonSchema: "null",
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: 'qgrid: jsonSchema top-level type must be "object"',
    });
  });

  it("accepts an Anthropic tuple under patternProperties and allocates a stream id (SON-532)", async () => {
    const { streamId } = await QgridFrame.prepareStream({
      prompt: "hi",
      model: "anthropic/claude-opus-4-8",
      jsonSchema: JSON.stringify({
        type: "object",
        patternProperties: {
          "^tuple$": {
            type: "array",
            prefixItems: [{ type: "string" }],
          },
        },
      }),
    });

    expect(streamId).toEqual(expect.any(String));
  });

  it("returns 400 for a deeply nested tool schema before allocating a stream id", async () => {
    await expect(
      QgridFrame.prepareStream({
        prompt: "hi",
        model: "anthropic/claude-sonnet-4-6",
        tools: [{ name: "deepTool", inputSchema: deeplyNestedInputSchema(256) }],
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("tools[0].inputSchema exceeds depth limit"),
    });
  });

  // strict 합성 시절엔 $defs rebase 때문에 named anchor $ref 를 거절해야 했다.
  // 프롬프트 전달은 원문을 그대로 안내하므로 재작성이 없고 거절 사유도 사라진다(SON-532).
  it("accepts a named-anchor $ref on Anthropic and allocates a stream id (SON-532)", async () => {
    const { streamId } = await QgridFrame.prepareStream({
      prompt: "hi",
      model: "anthropic/claude-sonnet-4-6",
      tools: [{ name: "lookup", inputSchema: { type: "object" } }],
      jsonSchema: JSON.stringify({
        type: "object",
        properties: { answer: { $ref: "#named-anchor" } },
      }),
    });

    expect(streamId).toEqual(expect.any(String));
  });

  it("accepts an Anthropic schema beyond the old argv limit and allocates a stream id (SON-532)", async () => {
    const { streamId } = await QgridFrame.prepareStream({
      prompt: "hi",
      model: "anthropic/claude-sonnet-4-6",
      tools: [
        {
          name: "lookup",
          description: "x".repeat(64 * 1024),
          inputSchema: { type: "object" },
        },
      ],
    });

    expect(streamId).toEqual(expect.any(String));
  });
});

describe("QgridFrame raw lifecycle API", () => {
  it("treats createRun.modelName as the requested model", async () => {
    requestLogCreateRunMock.mockReset().mockResolvedValue(81);

    await expect(
      QgridFrame.createRun({
        userPrompt: "hi",
        modelName: "google/gemini-3-flash",
        projectName: "external",
      }),
    ).resolves.toEqual({ requestLogId: 81 });

    expect(requestLogCreateRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requested_model_name: "google/gemini-3-flash",
      }),
    );
    expect(requestLogCreateRunMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ model_name: expect.anything() }),
    );
  });
});

describe("QgridFrame.queryStream request logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    beforeQueryMock.mockReset().mockResolvedValue({ requestLogId: 52, stepIndex: 0 });
    afterQueryMock.mockReset().mockResolvedValue({});
    assertNativeRunAdmissionMock.mockReset();
    finishRunWithErrorMock.mockReset();
    finishRunAbortedMock.mockReset();
    dispatcherQueryStreamMock.mockReset();
  });

  function streamOutput() {
    return {
      text: "hello",
      content: [{ type: "text", text: "hello" }],
      finishReason: "stop",
      tokenName: "tok-A",
      model: "gpt-5-codex",
      usage: {
        input_tokens: 5,
        output_tokens: 7,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      durationMs: 120,
      ttftMs: 39,
      costUsd: 0.001,
      costSource: "pricing_table",
      runContext: {
        threadCoord: {
          workerId: 1,
          threadId: "thread-1",
          epoch: 2,
          systemHash: "system-hash",
        },
      },
    };
  }

  it("rejects stream preparation while restart admission is closed", async () => {
    assertNativeRunAdmissionMock.mockImplementationOnce(() => {
      throw Object.assign(new Error("server restarting"), { statusCode: 503 });
    });

    await expect(QgridFrame.prepareStream({ prompt: "hi" })).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(dispatcherQueryStreamMock).not.toHaveBeenCalled();
  });

  it("rechecks admission before dispatching a previously prepared stream", async () => {
    const { streamId } = await QgridFrame.prepareStream({ prompt: "hi", logger: false });
    assertNativeRunAdmissionMock.mockImplementationOnce(() => {
      throw Object.assign(new Error("server restarting"), { statusCode: 503 });
    });

    await expect(QgridFrame.queryStream(streamId)).rejects.toMatchObject({ statusCode: 503 });
    expect(dispatcherQueryStreamMock).not.toHaveBeenCalled();
  });

  function installSseContext() {
    let closeHandler: (() => void) | undefined;
    const sse = {
      closed: false,
      publish: vi.fn(),
      onClose: vi.fn((handler: () => void) => {
        closeHandler = handler;
      }),
      end: vi.fn(async () => {}),
      triggerClose: () => closeHandler?.(),
    };
    vi.spyOn(Sonamu, "getContext").mockReturnValue({
      createSSE: vi.fn(() => sse),
    } as never);
    return sse;
  }

  it("creates the running row before starting provider streaming", async () => {
    const order: string[] = [];
    const sse = installSseContext();
    beforeQueryMock.mockImplementationOnce(async () => {
      order.push("before");
      return { requestLogId: 52, stepIndex: 0 };
    });
    dispatcherQueryStreamMock.mockImplementationOnce(
      async (
        _args: unknown,
        callbacks: { onComplete: (result: ReturnType<typeof streamOutput>) => void },
      ) => {
      order.push("dispatch");
      callbacks.onComplete(streamOutput());
      },
    );
    afterQueryMock.mockImplementationOnce(async () => {
      order.push("after");
      return {};
    });
    const args = { prompt: "hi", model: "openai/gpt-5-codex" };
    const { streamId } = await QgridFrame.prepareStream(args);

    await QgridFrame.queryStream(streamId);

    expect(order).toEqual(["before", "dispatch", "after"]);
    expect(sse.publish).toHaveBeenCalledWith(
      "done",
      expect.objectContaining({ runContext: streamOutput().runContext }),
    );
  });

  it("captures client close while beforeQuery is pending and skips provider dispatch", async () => {
    const sse = installSseContext();
    let beforeQueryStarted!: () => void;
    let resolveBeforeQuery!: (value: { requestLogId: number; stepIndex: number }) => void;
    const started = new Promise<void>((resolve) => {
      beforeQueryStarted = resolve;
    });
    beforeQueryMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveBeforeQuery = resolve;
          beforeQueryStarted();
        }),
    );
    const args = { prompt: "hi", model: "openai/gpt-5-codex" };
    const { streamId } = await QgridFrame.prepareStream(args);

    const streamPromise = QgridFrame.queryStream(streamId);
    await started;
    expect(sse.onClose).toHaveBeenCalledOnce();
    sse.triggerClose();
    resolveBeforeQuery({ requestLogId: 52, stepIndex: 0 });
    await streamPromise;

    expect(finishRunAbortedMock).toHaveBeenCalledWith(52, args);
    expect(dispatcherQueryStreamMock).not.toHaveBeenCalled();
    expect(sse.end).toHaveBeenCalledOnce();
  });

  it("publishes the provider result when afterQuery persistence fails", async () => {
    const sse = installSseContext();
    dispatcherQueryStreamMock.mockImplementationOnce(
      async (
        _args: unknown,
        callbacks: { onComplete: (result: ReturnType<typeof streamOutput>) => void },
      ) => {
        callbacks.onComplete(streamOutput());
      },
    );
    afterQueryMock.mockRejectedValueOnce(new Error("request log unavailable"));
    const args = { prompt: "hi", model: "openai/gpt-5-codex" };
    const { streamId } = await QgridFrame.prepareStream(args);

    await QgridFrame.queryStream(streamId);

    expect(finishRunWithErrorMock).toHaveBeenCalledWith(52, "request log unavailable", args);
    expect(sse.publish).toHaveBeenCalledWith(
      "done",
      expect.objectContaining({ text: "hello", runContext: streamOutput().runContext }),
    );
    expect(sse.publish).not.toHaveBeenCalledWith("error", expect.anything());
  });

  it("publishes an error when provider execution fails while the client is connected", async () => {
    const sse = installSseContext();
    dispatcherQueryStreamMock.mockImplementationOnce(
      async (_args: unknown, callbacks: { onError: (error: Error) => void }) => {
        callbacks.onError(new Error("provider failed"));
      },
    );
    const args = { prompt: "hi", model: "openai/gpt-5-codex" };
    const { streamId } = await QgridFrame.prepareStream(args);

    await QgridFrame.queryStream(streamId);

    expect(finishRunWithErrorMock).toHaveBeenCalledWith(52, "provider failed", args);
    expect(finishRunAbortedMock).not.toHaveBeenCalled();
    expect(sse.publish).toHaveBeenCalledWith("error", { message: "provider failed" });
  });

  it.each([
    ["openai", "openai/gpt-5.6-terra", "gpt-5.6-terra"],
    ["anthropic", "anthropic/claude-sonnet-4-6", "claude-sonnet-4-6"],
  ] as const)(
    "finishes a malformed %s structured stream through the real dispatcher without hanging",
    async (provider, requestedModel, servedModel) => {
      const sse = installSseContext();
      const { QgridDispatcherClass } =
        await vi.importActual<typeof import("./qgrid.dispatcher")>("./qgrid.dispatcher");
      const dispatcher = new QgridDispatcherClass();
      const generateStream = vi.fn(
        async (
          _request: unknown,
          callbacks: {
            onComplete: (result: {
              text: string;
              tokenName: string;
              usage: {
                totalTokens: number;
                inputTokens: number;
                cachedInputTokens: number;
                outputTokens: number;
                reasoningOutputTokens: number;
              };
              durationMs: number;
              model: string;
              threadCoord: { workerId: number; threadId: string; epoch: number };
            }) => void;
          },
        ) => {
          // 실제 provider adapter 완료 지점: toolCalls 누락 envelope가 dispatcher mapper에서 throw.
          callbacks.onComplete({
            text: '{"action":"answer","answer":{"result":"ok"}}',
            tokenName: `${provider}/test`,
            usage: {
              totalTokens: 10,
              inputTokens: 5,
              cachedInputTokens: 0,
              outputTokens: 5,
              reasoningOutputTokens: 0,
            },
            durationMs: 12,
            model: servedModel,
            threadCoord: { workerId: 1, threadId: "thread-malformed", epoch: 0 },
          });
        },
      );
      if (provider === "openai") {
        dispatcher.openaiDispatcher = { generateStream } as never;
      } else {
        dispatcher.anthropicDispatcher = { generateStream } as never;
      }
      dispatcherQueryStreamMock.mockImplementationOnce((args, callbacks, signal) =>
        dispatcher.queryStream(args, callbacks, signal),
      );

      const args = {
        prompt: "answer",
        model: requestedModel,
        tools: [{ name: "lookup", inputSchema: { type: "object" } }],
        jsonSchema: JSON.stringify({
          type: "object",
          properties: { result: { type: "string" } },
        }),
      };
      const { streamId } = await QgridFrame.prepareStream(args);

      await expect(QgridFrame.queryStream(streamId)).resolves.toBeUndefined();

      expect(generateStream).toHaveBeenCalledOnce();
      expect(finishRunWithErrorMock).toHaveBeenCalledWith(
        52,
        expect.stringContaining("invalid tool envelope"),
        args,
      );
      const errorMessage = finishRunWithErrorMock.mock.calls[0]?.[1];
      expect(afterQueryMock).not.toHaveBeenCalled();
      expect(sse.publish).toHaveBeenCalledWith("error", { message: errorMessage });
      expect(sse.end).toHaveBeenCalledOnce();
    },
  );

  it("marks the run aborted on close regardless of the provider error message", async () => {
    const sse = installSseContext();
    dispatcherQueryStreamMock.mockImplementationOnce(
      async (
        _args: unknown,
        callbacks: { onError: (error: Error) => void },
        signal: AbortSignal,
      ) => {
        expect(signal.aborted).toBe(false);
        sse.triggerClose();
        expect(signal.aborted).toBe(true);
        callbacks.onError(new Error("provider connection reset"));
      },
    );
    const args = { prompt: "hi", model: "openai/gpt-5-codex" };
    const { streamId } = await QgridFrame.prepareStream(args);

    await QgridFrame.queryStream(streamId);

    expect(finishRunAbortedMock).toHaveBeenCalledWith(52, args);
    expect(finishRunWithErrorMock).not.toHaveBeenCalled();
    expect(sse.publish).not.toHaveBeenCalled();
  });

  it("records a provider result after close but finishes the run as aborted", async () => {
    const sse = installSseContext();
    dispatcherQueryStreamMock.mockImplementationOnce(
      async (
        _args: unknown,
        callbacks: { onComplete: (result: ReturnType<typeof streamOutput>) => void },
      ) => {
        sse.triggerClose();
        callbacks.onComplete(streamOutput());
      },
    );
    const args = { prompt: "hi", model: "openai/gpt-5-codex" };
    const { streamId } = await QgridFrame.prepareStream(args);

    await QgridFrame.queryStream(streamId);

    expect(afterQueryMock).toHaveBeenCalledWith(52, 0, args, streamOutput());
    expect(finishRunAbortedMock).toHaveBeenCalledWith(52, args);
    expect(sse.publish).not.toHaveBeenCalled();
  });

  it("marks the run aborted when the client closes before afterQuery commits", async () => {
    const sse = installSseContext();
    let afterQueryStarted!: () => void;
    let resolveAfterQuery!: (value: object) => void;
    const started = new Promise<void>((resolve) => {
      afterQueryStarted = resolve;
    });
    afterQueryMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveAfterQuery = resolve;
          afterQueryStarted();
        }),
    );
    dispatcherQueryStreamMock.mockImplementationOnce(
      async (
        _args: unknown,
        callbacks: { onComplete: (result: ReturnType<typeof streamOutput>) => void },
      ) => {
        callbacks.onComplete(streamOutput());
      },
    );
    const args = { prompt: "hi", model: "openai/gpt-5-codex" };
    const { streamId } = await QgridFrame.prepareStream(args);

    const streamPromise = QgridFrame.queryStream(streamId);
    await started;
    sse.triggerClose();
    resolveAfterQuery({});
    await streamPromise;

    expect(finishRunAbortedMock).toHaveBeenCalledWith(52, args);
    expect(sse.publish).not.toHaveBeenCalledWith("done", expect.anything());
  });

  it("streams with thread context but no log writes when logger is false", async () => {
    const sse = installSseContext();
    dispatcherQueryStreamMock.mockImplementationOnce(
      async (
        _args: unknown,
        callbacks: { onComplete: (result: ReturnType<typeof streamOutput>) => void },
      ) => {
        callbacks.onComplete(streamOutput());
      },
    );
    const { streamId } = await QgridFrame.prepareStream({
      prompt: "hi",
      model: "openai/gpt-5-codex",
      logger: false,
    });

    await QgridFrame.queryStream(streamId);

    expect(beforeQueryMock).not.toHaveBeenCalled();
    expect(afterQueryMock).not.toHaveBeenCalled();
    expect(finishRunWithErrorMock).not.toHaveBeenCalled();
    expect(sse.onClose).toHaveBeenCalledOnce();
    expect(sse.publish).toHaveBeenCalledWith(
      "done",
      expect.objectContaining({ runContext: streamOutput().runContext }),
    );
  });
});

describe("QgridFrame.usage", () => {
  beforeEach(() => {
    findManyMock.mockReset();
    getRateLimitsByTokenIdMock.mockReset();
  });

  it("returns empty usage for inactive OpenAI tokens without asking for workers", async () => {
    findManyMock.mockResolvedValueOnce({
      rows: [
        {
          ...tokenEntry,
          provider: "openai",
          credentials: {
            accessToken: "access",
            refreshToken: "refresh",
            accountId: "account",
          },
          active: false,
        },
      ],
    });

    await expect(QgridFrame.usage(1)).resolves.toEqual({
      provider: "openai",
      fiveHour: null,
      sevenDay: null,
    });
    expect(getRateLimitsByTokenIdMock).not.toHaveBeenCalled();
  });

  it("returns the provider-reported OpenAI window duration", async () => {
    findManyMock.mockResolvedValueOnce({
      rows: [{ ...tokenEntry, provider: "openai", active: true }],
    });
    getRateLimitsByTokenIdMock.mockResolvedValueOnce({
      data: {
        rateLimits: {
          primary: { usedPercent: 11, resetsAt: 1_784_000_000, windowDurationMins: 10_080 },
          secondary: null,
        },
      },
    });

    await expect(QgridFrame.usage(1)).resolves.toEqual({
      provider: "openai",
      fiveHour: {
        utilization: 11,
        resetsAt: new Date(1_784_000_000 * 1_000).toISOString(),
        windowDurationMins: 10_080,
      },
      sevenDay: null,
    });
  });
});
