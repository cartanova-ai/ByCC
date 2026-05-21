export type QgridUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
};

export type QgridTool = {
  name: string;
  description?: string;
  inputSchema: unknown;
};

export type QgridContent =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: string };

export type QgridBase = {
  usage: QgridUsage;
  durationMs: number;
  costUsd: number;
  text: string;
  content: QgridContent[];
  finishReason: "stop" | "tool-calls";
  model?: string;
  tokenName?: string;
};

export type QgridResponse = QgridBase & { data: string };
export type QgridTypedResponse<T> = QgridBase & { data: T };
