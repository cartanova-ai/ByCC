export type JsonValue =
  | number
  | string
  | boolean
  | JsonValue[]
  | { [key: string]: JsonValue | undefined }
  | null;

export type UserInput =
  | { type: "text"; text: string; text_elements: TextElement[] }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string }
  | { type: "skill"; name: string; path: string }
  | { type: "mention"; name: string; path: string };

export type TextElement = {
  byteRange: { start: number; end: number };
  placeholder: string | null;
};

export type TokenUsageBreakdown = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

export type QuotaRateLimitWindow = {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
};

export type QuotaRateLimitSnapshot = {
  limitId: string | null;
  limitName: string | null;
  primary: QuotaRateLimitWindow | null;
  secondary: QuotaRateLimitWindow | null;
  credits: JsonValue;
  planType: string | null;
  rateLimitReachedType: string | null;
};

export type QuotaRateLimits = {
  rateLimits: QuotaRateLimitSnapshot;
  rateLimitsByLimitId: { [key: string]: QuotaRateLimitSnapshot | undefined } | null;
};
