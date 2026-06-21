import { describe, expect, it } from "vitest";

import { buildToolCallSchema } from "./tool-emulation";
import { type QgridTool } from "./qgrid.types";

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
    expect(schema.description).toContain("Do not invoke listed client tools as native Claude Code tools");
    expect(schema.properties?.action?.description).toContain("tool_call");
    expect(schema.properties?.toolCalls?.description).toContain("Do not call these tools as native");
    expect(
      schema.properties?.toolCalls?.anyOf?.[0]?.items?.properties?.toolName?.description,
    ).toContain("getWeather");
  });
});
