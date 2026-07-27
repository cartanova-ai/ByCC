import { type JsonValue } from "../../codex-protocol/serde_json/JsonValue";
import { type QgridTool } from "./qgrid.types";

const USER_OUTPUT_DEFINITION = "__qgrid_user_output";
const USER_OUTPUT_REF = `#/$defs/${USER_OUTPUT_DEFINITION}`;

export class ToolSchemaCompositionError extends Error {
  constructor(
    message: string,
    public path: string,
  ) {
    super(`tool schema composition: ${message} (at ${path})`);
    this.name = "ToolSchemaCompositionError";
  }
}

export function buildToolCallSchema(tools: QgridTool[], answerSchema?: JsonValue): JsonValue {
  const toolDescriptions = tools
    .map((tool) => {
      const schema = JSON.stringify(tool.inputSchema);
      return `- ${tool.name}: ${tool.description ?? ""}\n  inputSchema: ${schema}`;
    })
    .join("\n");

  const normalizedAnswerSchema =
    answerSchema === undefined ? undefined : rebaseUserOutputSchema(answerSchema);

  return {
    type: "object",
    description:
      "Use this schema only through StructuredOutput. Do not invoke listed client tools as native Claude Code tools. To request client-side tool execution, set action to tool_call and include toolCalls. Use action answer only when no further client tool result is needed.",
    properties: {
      action: {
        type: "string",
        enum: ["answer", "tool_call"],
        description:
          "Use tool_call to request client-side tool execution through this structured output. Use answer only for a final answer.",
      },
      answer: {
        anyOf: [
          normalizedAnswerSchema === undefined ? { type: "string" } : { $ref: USER_OUTPUT_REF },
          { type: "null" },
        ],
      },
      toolCalls: {
        description:
          "Client-side tool calls requested through structured output. Do not call these tools as native Claude Code tools.",
        anyOf: [
          {
            type: "array",
            items: {
              type: "object",
              properties: {
                toolName: {
                  type: "string",
                  enum: tools.map((tool) => tool.name),
                  description: `Client-side tool name to request through structured output. Do not call this as a native Claude Code tool.\n${toolDescriptions}`,
                },
                args: {
                  type: "string",
                  description: "Tool arguments as a JSON string for the client-side tool.",
                },
              },
              required: ["toolName", "args"],
              additionalProperties: false,
            },
          },
          { type: "null" },
        ],
      },
    },
    required: ["action", "answer", "toolCalls"],
    additionalProperties: false,
    ...(normalizedAnswerSchema === undefined
      ? {}
      : {
          $defs: {
            [USER_OUTPUT_DEFINITION]: normalizedAnswerSchema,
          },
        }),
  };
}

function rebaseUserOutputSchema(schema: JsonValue): JsonValue {
  return rewriteSchemaNode(schema, "$");
}

const SCHEMA_MAP_KEYWORDS = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);
const SCHEMA_ARRAY_KEYWORDS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const SCHEMA_KEYWORDS = new Set([
  "additionalItems",
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

function rewriteSchemaNode(value: JsonValue, path: string): JsonValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;

  const source = value as Record<string, JsonValue>;
  const result: Record<string, JsonValue> = { ...source };

  for (const unsupportedKeyword of ["$id", "$dynamicRef", "$recursiveRef", "$recursiveAnchor"]) {
    if (unsupportedKeyword in source) {
      throw new ToolSchemaCompositionError(
        `${unsupportedKeyword} is not supported`,
        `${path}.${unsupportedKeyword}`,
      );
    }
  }

  if ("$ref" in source) {
    const ref = source.$ref;
    if (typeof ref !== "string" || (ref !== "#" && !ref.startsWith("#/"))) {
      throw new ToolSchemaCompositionError(
        "only root-relative JSON Pointer $ref values are supported",
        `${path}.$ref`,
      );
    }
    result.$ref = `${USER_OUTPUT_REF}${ref.slice(1)}`;
  }

  for (const [keyword, child] of Object.entries(source)) {
    const keywordPath = `${path}.${keyword}`;

    if (SCHEMA_MAP_KEYWORDS.has(keyword) && isJsonObject(child)) {
      result[keyword] = Object.fromEntries(
        Object.entries(child).map(([name, schema]) => [
          name,
          rewriteSchemaNode(schema, `${keywordPath}.${name}`),
        ]),
      ) as JsonValue;
    } else if (keyword === "dependencies" && isJsonObject(child)) {
      result[keyword] = Object.fromEntries(
        Object.entries(child).map(([name, dependency]) => [
          name,
          Array.isArray(dependency)
            ? dependency
            : rewriteSchemaNode(dependency, `${keywordPath}.${name}`),
        ]),
      ) as JsonValue;
    } else if (SCHEMA_ARRAY_KEYWORDS.has(keyword) && Array.isArray(child)) {
      result[keyword] = child.map((schema, index) =>
        rewriteSchemaNode(schema, `${keywordPath}[${index}]`),
      ) as JsonValue;
    } else if (SCHEMA_KEYWORDS.has(keyword)) {
      if (keyword === "items" && Array.isArray(child)) {
        result[keyword] = child.map((schema, index) =>
          rewriteSchemaNode(schema, `${keywordPath}[${index}]`),
        ) as JsonValue;
      } else {
        result[keyword] = rewriteSchemaNode(child, keywordPath);
      }
    }
  }

  return result as JsonValue;
}

function isJsonObject(value: JsonValue): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
