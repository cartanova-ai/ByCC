import { describe, expect, it, vi } from "vitest";

import {
  type GenerateRequest,
  type GenerateResult,
} from "../../utils/providers/common/provider-dispatcher";
import { QgridDispatcherClass } from "./qgrid.dispatcher";

describe("QgridDispatcherClass", () => {
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
