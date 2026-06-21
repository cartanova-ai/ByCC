import { describe, expect, it, vi } from "vitest";

import {
  type GenerateRequest,
  type GenerateResult,
} from "../../utils/providers/common/provider-dispatcher";
import { buildStrictOutputSchema, QgridDispatcherClass } from "./qgrid.dispatcher";

describe("QgridDispatcherClass", () => {
  it("jsonSchema 를 required + additionalProperties:false 로 strictify 한다", () => {
    const schema = buildStrictOutputSchema({
      jsonSchema: JSON.stringify({
        type: "object",
        properties: {
          contents: {
            type: "array",
            items: {
              type: "object",
              properties: { text: { type: "string" } },
            },
          },
        },
      }),
    }) as {
      required?: string[];
      additionalProperties?: boolean;
      properties?: {
        contents?: {
          items?: { required?: string[]; additionalProperties?: boolean };
        };
      };
    };

    expect(schema.required).toEqual(["contents"]);
    expect(schema.additionalProperties).toBe(false);
    const contentsArray = (
      schema.properties?.contents as {
        anyOf?: Array<{ items?: { required?: string[]; additionalProperties?: boolean } }>;
      }
    ).anyOf?.[0];
    expect(contentsArray?.items?.required).toEqual(["text"]);
    expect(contentsArray?.items?.additionalProperties).toBe(false);
  });

  it("Anthropic provider 경로에 strictified outputSchema 를 전달한다", async () => {
    const dispatcher = new QgridDispatcherClass();
    const generate = vi.fn(
      async (_req: GenerateRequest): Promise<GenerateResult> => ({
        text: '{"contents":[{"text":"ok"}]}',
        tokenName: "anthropic/test",
        usage: {
          totalTokens: 10,
          inputTokens: 5,
          cachedInputTokens: 0,
          outputTokens: 5,
          reasoningOutputTokens: 0,
        },
        durationMs: 12,
        costUsd: 0.01,
        model: "claude-sonnet-4-6",
        threadCoord: { workerId: 1, threadId: "sess-1", epoch: 0 },
      }),
    );
    dispatcher.anthropicDispatcher = { generate } as never;

    await dispatcher.query({
      prompt: "hi",
      model: "anthropic/claude-sonnet-4-6",
      jsonSchema: JSON.stringify({
        type: "object",
        properties: { contents: { type: "array", items: { type: "object" } } },
      }),
    });

    const outputSchema = generate.mock.calls[0]![0].outputSchema as {
      required?: string[];
      additionalProperties?: boolean;
    };
    expect(outputSchema.required).toEqual(["contents"]);
    expect(outputSchema.additionalProperties).toBe(false);
  });

  it("provider 가 산출한 costUsd 를 가격표 fallback 보다 우선한다", async () => {
    const dispatcher = new QgridDispatcherClass();
    const generate = vi.fn(
      async (_req: GenerateRequest): Promise<GenerateResult> => ({
        text: "ok",
        tokenName: "anthropic/test",
        usage: {
          totalTokens: 1_110,
          inputTokens: 1_000,
          cachedInputTokens: 0,
          cacheCreationInputTokens: 600,
          outputTokens: 110,
          reasoningOutputTokens: 0,
        },
        durationMs: 12,
        costUsd: 0.123456,
        model: "claude-sonnet-4-6",
        threadCoord: { workerId: 1, threadId: "sess-1", epoch: 0 },
      }),
    );
    dispatcher.anthropicDispatcher = { generate } as never;

    const result = await dispatcher.query({ prompt: "hi", model: "claude-sonnet-4-6" });

    expect(result.costUsd).toBe(0.123456);
    expect(result.usage.cache_creation_input_tokens).toBe(600);
  });
});
