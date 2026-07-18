import { describe, expect, it } from "vitest";

import { type QgridTool } from "./qgrid.types";
import { applyToolCallEmulation, buildToolCallSchema } from "./tool-emulation";

describe("buildToolCallSchema", () => {
  it("documents that emulated tools must be requested through StructuredOutput", () => {
    const tools: QgridTool[] = [
      {
        name: "getWeather",
        description: "Get weather for a city",
        inputSchema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
          additionalProperties: false,
        },
      },
    ];

    const schema = buildToolCallSchema(tools) as {
      description?: string;
      properties?: {
        action?: { description?: string };
        toolCalls?: {
          description?: string;
          anyOf?: Array<{
            items?: {
              properties?: {
                toolName?: { description?: string };
              };
            };
          }>;
        };
      };
    };

    expect(schema.description).toContain("StructuredOutput");
    expect(schema.description).toContain(
      "Do not invoke listed client tools as native Claude Code tools",
    );
    expect(schema.properties?.action?.description).toContain("tool_call");
    expect(schema.properties?.toolCalls?.description).toContain(
      "Do not call these tools as native",
    );
    expect(
      schema.properties?.toolCalls?.anyOf?.[0]?.items?.properties?.toolName?.description,
    ).toContain("getWeather");
  });
});

describe("applyToolCallEmulation image parts", () => {
  const baseResult = {
    text: "here is your image",
    tokenName: "token",
    model: "gpt-5.5",
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    durationMs: 10,
    ttftMs: 0,
    costUsd: 0,
    costSource: "pricing_table" as const,
  };
  const img = { data: "iVBORw0KGgoBAgM", revisedPrompt: "a red circle" };

  it("appends an image part after text when images are present (no tools)", () => {
    const out = applyToolCallEmulation(baseResult, undefined, undefined, [img]);
    expect(out.content).toEqual([
      { type: "text", text: "here is your image" },
      { type: "image", data: "iVBORw0KGgoBAgM", revisedPrompt: "a red circle" },
    ]);
    // 이미지는 finishReason 과 직교 — 여전히 stop.
    expect(out.finishReason).toBe("stop");
  });

  it("appends multiple images preserving order", () => {
    const out = applyToolCallEmulation(baseResult, undefined, undefined, [
      { data: "iVBORw0KGgoAAA", revisedPrompt: "one" },
      { data: "iVBORw0KGgoBBB", revisedPrompt: "two" },
    ]);
    const images = out.content.filter((c) => c.type === "image");
    expect(images).toHaveLength(2);
    expect(images.map((c) => (c.type === "image" ? c.revisedPrompt : null))).toEqual(["one", "two"]);
  });

  it("leaves content unchanged when no images are passed (regression guard)", () => {
    const out = applyToolCallEmulation(baseResult, undefined, undefined);
    expect(out.content).toEqual([{ type: "text", text: "here is your image" }]);
  });
});
