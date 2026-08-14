import { createFileRoute, Link } from "@tanstack/react-router";
import JsonView from "@uiw/react-json-view";
import { lightTheme } from "@uiw/react-json-view/light";
import { type ReactNode, useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { z } from "zod";
import ArrowLeftIcon from "~icons/lucide/arrow-left";
import CheckIcon from "~icons/lucide/check";
import ChevronDownIcon from "~icons/lucide/chevron-down";
import CopyIcon from "~icons/lucide/copy";
import XIcon from "~icons/lucide/x";

import { cacheHitRate, formatMicroUsd } from "@/lib/cost";
import { type ToolDefinitions } from "@/services/request-log/request-log.types";
import { RequestLogService, RequestLogStepService } from "@/services/services.generated";
import {
  type RequestLogStepSubsetMapping,
  type RequestLogSubsetMapping,
} from "@/services/sonamu.generated";

type RequestLog = RequestLogSubsetMapping["A"];
type RequestLogStep = RequestLogStepSubsetMapping["T"];

const showSearchSchema = z.object({
  id: z.number(),
});

export const Route = createFileRoute("/requests/show")({
  validateSearch: showSearchSchema,
  component: RequestShowPage,
});

function RequestShowPage() {
  const { id } = Route.useSearch();
  return <RequestDetail id={id} />;
}

function formatNum(n: number): string {
  return n.toLocaleString();
}

type TokenRateProvider = "anthropic" | "openai";

// U0 duration 기준 실측이 끝난 provider만 opt-in한다. 미판정 기본값은 전 provider off.
const TOKENS_PER_SEC_PROVIDERS = new Set<TokenRateProvider>();

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function safeParseJson(text: string | null | undefined): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function CopyButton({ text, dark }: { text: string; dark?: boolean }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);
  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
  };
  return (
    <button
      type="button"
      className={`absolute top-2 right-2 p-1 rounded transition-colors ${
        dark ? "text-sand-500 hover:text-sand-300" : "text-sand-400 hover:text-sand-600"
      }`}
      onClick={handleCopy}
    >
      {copied ? (
        <CheckIcon className="size-3.5 text-sage-500" />
      ) : (
        <CopyIcon className="size-3.5" />
      )}
    </button>
  );
}

type ImageSegment = { type: "text"; text: string } | { type: "image"; src: string; alt: string };

const DATA_IMAGE_TAG_RE =
  /<img\s+[^>]*src=["'](data:image\/[^"']+;base64,[^"']+)["'][^>]*(?:alt=["']([^"']*)["'][^>]*)?\/?>/gi;

function parseImageSegments(text: string): ImageSegment[] {
  const segments: ImageSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(DATA_IMAGE_TAG_RE)) {
    const index = match.index ?? 0;
    if (index > cursor) segments.push({ type: "text", text: text.slice(cursor, index) });
    segments.push({ type: "image", src: match[1], alt: match[2] ?? "generated image" });
    cursor = index + match[0].length;
  }
  if (cursor < text.length) segments.push({ type: "text", text: text.slice(cursor) });
  return segments.filter((segment) => segment.type === "image" || segment.text.trim().length > 0);
}

function ImageAwareContent({ text, markdown }: { text: string; markdown?: boolean }) {
  const [viewerSrc, setViewerSrc] = useState<string | null>(null);
  const segments = parseImageSegments(text);
  const hasImage = segments.some((segment) => segment.type === "image");
  if (!hasImage) {
    return markdown ? (
      <div className="prose prose-sm prose-qgrid max-w-none">
        <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
      </div>
    ) : (
      <pre className="text-sm text-sand-800 whitespace-pre-wrap wrap-break-word font-mono leading-relaxed">
        {text}
      </pre>
    );
  }

  return (
    <div className="space-y-3">
      {segments.map((segment, index) =>
        segment.type === "text" ? (
          markdown ? (
            <div key={`text-${index}`} className="prose prose-sm prose-qgrid max-w-none">
              <Markdown remarkPlugins={[remarkGfm]}>{segment.text}</Markdown>
            </div>
          ) : (
            <pre
              key={`text-${index}`}
              className="text-sm text-sand-800 whitespace-pre-wrap wrap-break-word font-mono leading-relaxed"
            >
              {segment.text}
            </pre>
          )
        ) : (
          <button
            key={`image-${index}`}
            type="button"
            className="block max-w-full rounded-md border border-sand-200 overflow-hidden bg-white hover:border-sienna-300 transition-colors"
            onClick={() => setViewerSrc(segment.src)}
            title="Open image"
          >
            <img
              src={segment.src}
              alt={segment.alt}
              className="max-h-[520px] max-w-full object-contain"
              loading="lazy"
            />
          </button>
        ),
      )}
      {viewerSrc && (
        <div
          className="fixed inset-0 z-50 bg-black/70 p-4 flex items-center justify-center"
          onClick={() => setViewerSrc(null)}
        >
          <button
            type="button"
            className="absolute top-4 right-4 p-2 rounded-full bg-white/90 text-sand-700 hover:bg-white"
            onClick={() => setViewerSrc(null)}
            title="Close image"
          >
            <XIcon className="size-5" />
          </button>
          <img
            src={viewerSrc}
            alt="generated preview"
            className="max-h-full max-w-full object-contain rounded-md bg-white"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}

function FormattedContent({ text, markdown }: { text: string; markdown?: boolean }) {
  const parsed = tryParseJson(text);
  const [mode, setMode] = useState<"pretty" | "plain">("pretty");

  const canRenderJsonView =
    parsed.ok &&
    parsed.value !== null &&
    (Array.isArray(parsed.value) || typeof parsed.value === "object");

  if (!parsed.ok || !canRenderJsonView) {
    if (markdown) {
      return <ImageAwareContent text={text} markdown />;
    }
    return <ImageAwareContent text={parsed.ok ? JSON.stringify(parsed.value, null, 2) : text} />;
  }

  return (
    <div>
      <div className="flex gap-1 mb-2">
        <button
          type="button"
          className={`px-2 py-0.5 text-[10px] rounded-md transition-colors ${mode === "plain" ? "bg-sand-200 text-sand-700" : "text-sand-400 hover:text-sand-600"}`}
          onClick={() => setMode("plain")}
        >
          Plain
        </button>
        <button
          type="button"
          className={`px-2 py-0.5 text-[10px] rounded-md transition-colors ${mode === "pretty" ? "bg-sand-200 text-sand-700" : "text-sand-400 hover:text-sand-600"}`}
          onClick={() => setMode("pretty")}
        >
          Pretty
        </button>
      </div>
      {mode === "pretty" ? (
        <JsonView
          value={parsed.value as object}
          style={lightTheme}
          displayDataTypes={false}
          enableClipboard
          collapsed={false}
        />
      ) : (
        <pre className="text-sm text-sand-800 whitespace-pre-wrap wrap-break-word font-mono leading-relaxed">
          {JSON.stringify(parsed.value, null, 2)}
        </pre>
      )}
    </div>
  );
}

function Section({
  title,
  defaultOpen = true,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details open={defaultOpen} className="group panel overflow-hidden">
      <summary className="panel-header flex items-center gap-1.5 cursor-pointer select-none list-none px-4 py-2.5">
        <ChevronDownIcon className="size-3.5 text-sand-400 transition-transform group-open:rotate-0 -rotate-90" />
        <span className="text-[11px] uppercase tracking-wider text-sand-500 font-medium">
          {title}
        </span>
      </summary>
      <div className="p-4">{children}</div>
    </details>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wider text-sand-400 font-medium truncate">
        {label}
      </dt>
      <dd className="text-[15px] font-semibold text-sand-800 tabular-nums mt-0.5 truncate">
        {value}
      </dd>
    </div>
  );
}

const STATUS_STYLE: Record<string, string> = {
  running: "bg-blue-100 text-blue-600",
  succeeded: "bg-sage-100 text-sage-600",
  error: "bg-red-100 text-red-600",
  aborted: "bg-caution-400/15 text-caution-500",
};

function ErrorPanel({ message }: { message: string }) {
  return (
    <div className="panel overflow-hidden border border-red-200 bg-red-50/60">
      <div className="px-4 py-2.5 border-b border-red-100 flex items-center gap-1.5">
        <span className="text-[11px] uppercase tracking-wider text-red-600 font-medium">Error</span>
      </div>
      <div className="p-4">
        <pre className="text-[12px] text-red-700 whitespace-pre-wrap break-words font-mono leading-relaxed max-h-80 overflow-auto">
          {message}
        </pre>
      </div>
    </div>
  );
}

function HeaderBar({ data }: { data: RequestLog }) {
  const isRunning = data.status === "running";
  const hasFallback =
    !isRunning &&
    data.requested_model_name !== null &&
    data.model_name !== null &&
    data.requested_model_name !== data.model_name;
  const hasRequestedOnly =
    !isRunning && data.requested_model_name !== null && data.model_name === null;

  return (
    // 모델명이 길어 한 줄에 안 들어가면 나머지 배지가 밖으로 밀린다. wrap 으로 접히게 한다.
    <div className="panel overflow-hidden px-4 py-3 flex flex-wrap items-center gap-x-2 gap-y-1.5 sm:px-5">
      <span className="text-[15px] font-semibold text-sand-900 break-all">
        {isRunning
          ? "실행 중"
          : hasFallback
            ? `${data.requested_model_name} → ${data.model_name}`
            : (data.model_name ?? data.requested_model_name ?? "Unknown model")}
      </span>
      {hasRequestedOnly && <span className="text-[10px] text-sand-400">요청</span>}
      {!isRunning && (data.fallback_count ?? 0) > 0 && (
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-caution-400/15 text-caution-500 font-medium uppercase">
          fallback ×{data.fallback_count}
        </span>
      )}
      {!isRunning && data.status !== "succeeded" && (
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium uppercase ${STATUS_STYLE[data.status] ?? "bg-sand-100 text-sand-500"}`}
        >
          {data.status}
        </span>
      )}
      {data.response_json_ok === false && (
        <span
          title="structured 요청의 응답이 JSON 파싱에 실패했습니다"
          className="text-[10px] px-1.5 py-0.5 rounded-full bg-caution-400/15 text-caution-500 font-medium uppercase"
        >
          broken json
        </span>
      )}
      {data.effort && (
        <span className="text-[11px] px-1.5 py-0.5 rounded-md bg-sand-100 text-sand-500 font-mono">
          effort={data.effort}
        </span>
      )}
      {data.project_name && (
        <span className="text-[12px] text-sand-400">· project={data.project_name}</span>
      )}
      <span className="ml-auto text-[11px] text-sand-400">{data.token_name}</span>
    </div>
  );
}

function MetricsPanel({ data, toolCallCount }: { data: RequestLog; toolCallCount: number }) {
  const tokensPerSecEnabled = isTokensPerSecEnabled(data);
  return (
    <div className="panel overflow-hidden px-5 py-3 space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-x-6 gap-y-3">
        <Metric label="Duration" value={`${(data.duration_ms / 1000).toFixed(1)}s`} />
        <Metric label="TTFT" value={formatRunTtftMs(data.ttft_ms)} />
        <Metric
          label="Tokens/sec"
          value={formatTokensPerSec(
            data.output_tokens,
            data.duration_ms,
            data.ttft_ms,
            tokensPerSecEnabled,
          )}
        />
        <Metric
          label="Driver Cost"
          value={data.cost_usd !== null ? formatMicroUsd(data.cost_usd) : "—"}
        />
        <Metric label="Cost Source" value={data.cost_source ?? "legacy"} />
        <Metric
          label="Image Cost"
          value={data.image_cost_usd !== null ? formatMicroUsd(data.image_cost_usd) : "—"}
        />
        <Metric label="Tool Calls" value={`${toolCallCount}회`} />
      </div>
      <div className="border-t border-sand-100/60 pt-3 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-x-6 gap-y-3">
        <Metric label="Input" value={formatNum(data.input_tokens)} />
        <Metric label="Output" value={formatNum(data.output_tokens)} />
        <Metric label="Cache Read" value={formatNum(data.cache_read_tokens)} />
        <Metric label="Cache Write" value={formatNum(data.cache_creation_tokens)} />
        <Metric
          label="Cache Write (5m)"
          value={
            data.cache_creation_5m_tokens === null ? "—" : formatNum(data.cache_creation_5m_tokens)
          }
        />
        <Metric
          label="Cache Write (1h)"
          value={
            data.cache_creation_1h_tokens === null ? "—" : formatNum(data.cache_creation_1h_tokens)
          }
        />
        <Metric label="Cache Hit" value={cacheHitRate(data)} />
      </div>
    </div>
  );
}

type ToolCallEntry = {
  id: number;
  stepIndex: number;
  callIndex: number;
  toolCallId: string;
  toolName: string;
  durationMs: number;
  error: string | null;
};

type ToolInputImage = {
  mediaType?: string;
  data?: string;
  url?: string;
  byteSize?: number;
};

type GenerateStepEntry = {
  id: number;
  stepIndex: number;
  modelName: string | null;
  requestedModelName: string | null;
  fallbackCount: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  cacheCreation5mTokens: number | null;
  cacheCreation1hTokens: number | null;
  costUsd: number | null;
  costSource: string | null;
  durationMs: number | null;
  ttftMs: number | null;
  finishReason: string | null;
  reasoningTokens: number | null;
};

type StepTreeEntry = {
  stepIndex: number;
  generate: GenerateStepEntry | null;
  toolCalls: ToolCallEntry[];
};

function formatDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function formatRunTtftMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || ms <= 0) return "—";
  return formatDurationMs(ms);
}

function detectTokenRateProvider(source: {
  model_name?: string | null;
  token_name?: string | null;
}): TokenRateProvider | null {
  const modelName = source.model_name?.trim().toLowerCase();
  if (modelName) {
    const canonical = modelName.includes("/") ? modelName.split("/").pop()! : modelName;
    if (canonical.startsWith("claude-")) return "anthropic";
    if (/^(gpt-|codex-|o\d)/.test(canonical)) return "openai";
  }

  const tokenName = source.token_name?.trim().toLowerCase();
  if (tokenName?.startsWith("anthropic/")) return "anthropic";
  if (tokenName?.startsWith("openai/")) return "openai";
  return null;
}

function isTokensPerSecEnabled(source: {
  model_name?: string | null;
  token_name?: string | null;
}): boolean {
  const provider = detectTokenRateProvider(source);
  return provider !== null && TOKENS_PER_SEC_PROVIDERS.has(provider);
}

function formatTokensPerSec(
  outputTokens: number | null | undefined,
  durationMs: number | null | undefined,
  ttftMs: number | null | undefined,
  enabled: boolean,
): string {
  if (
    !enabled ||
    outputTokens === null ||
    outputTokens === undefined ||
    durationMs === null ||
    durationMs === undefined ||
    ttftMs === null ||
    ttftMs === undefined ||
    ttftMs <= 0
  ) {
    return "—";
  }
  const generationMs = durationMs - ttftMs;
  if (outputTokens <= 0 || generationMs <= 0) return "—";
  return `${Math.round(outputTokens / (generationMs / 1000)).toLocaleString()} tok/s`;
}

function CompactMetric({ label, value }: { label: string; value: string }) {
  return (
    // min-w-0 이 없으면 "Tokens/sec" 같은 긴 라벨이 그리드 셀을 밀어내 옆 칸 위로 겹친다.
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-sand-400 font-medium truncate">
        {label}
      </div>
      <div className="mt-0.5 text-[13px] font-semibold text-sand-800 tabular-nums truncate">
        {value}
      </div>
    </div>
  );
}

function readToolInputImages(args: unknown): unknown[] | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  const inputImages = (args as { inputImages?: unknown }).inputImages;
  return Array.isArray(inputImages) ? inputImages : undefined;
}

function getToolInputImages(args: unknown): ToolInputImage[] {
  return (readToolInputImages(args) ?? []).filter((item): item is ToolInputImage => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const image = item as ToolInputImage;
    return (
      (typeof image.url === "string" && image.url.length > 0) ||
      (typeof image.data === "string" && image.data.length > 0)
    );
  });
}

function hideToolInputImages(args: unknown): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const record = args as Record<string, unknown>;
  const inputImages = readToolInputImages(record);
  if (!inputImages) return args;
  return {
    ...record,
    inputImages: inputImages.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      const image = item as ToolInputImage;
      const maskedUrl =
        typeof image.url === "string" && image.url.toLowerCase().startsWith("data:")
          ? `[data-url ${image.url.length} chars]`
          : image.url;
      return {
        mediaType: image.mediaType,
        byteSize: image.byteSize,
        ...(maskedUrl ? { url: maskedUrl } : {}),
        ...(image.data ? { data: `[base64 ${image.data.length} chars]` } : {}),
      };
    }),
  };
}

function ToolInputImages({ images }: { images: ToolInputImage[] }) {
  const renderableImages = images
    .map((image, index) => {
      const urlSrc = image.url && !image.url.startsWith("[") ? image.url : undefined;
      const dataSrc = image.data
        ? `data:${image.mediaType ?? "image/png"};base64,${image.data}`
        : "";
      const src = urlSrc ?? dataSrc;
      return src ? { image, index, src } : null;
    })
    .filter((item): item is { image: ToolInputImage; index: number; src: string } => item !== null);
  if (renderableImages.length === 0) return null;
  return (
    <div>
      <span className="text-[10px] uppercase tracking-wider text-sand-400 font-medium px-2">
        Input Images
      </span>
      <div className="mt-1 grid grid-cols-1 sm:grid-cols-2 gap-2">
        {renderableImages.map(({ image, index, src }) => {
          return (
            <div
              key={`${image.mediaType ?? "image"}-${index}`}
              className="rounded-md border border-sand-200 bg-white overflow-hidden"
            >
              <img
                src={src}
                alt={`reference ${index + 1}`}
                className="max-h-64 w-full object-contain bg-white"
                loading="lazy"
              />
              <div className="px-2 py-1 text-[10px] text-sand-500 font-mono border-t border-sand-100">
                {image.mediaType ?? "image"} ·{" "}
                {image.byteSize !== undefined ? `${image.byteSize.toLocaleString()} bytes` : "url"}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RequestInputImages({ stepId }: { stepId: number | null }) {
  const { data: detail } = RequestLogStepService.useRequestLogStep("I", stepId ?? 0, {
    enabled: stepId !== null,
  });
  const args = detail ? safeParseJson(detail.tool_args) : null;
  return <ToolInputImages images={getToolInputImages(args)} />;
}

function ToolCallItem({ entry }: { entry: ToolCallEntry }) {
  const hasError = !!entry.error;
  const [opened, setOpened] = useState(false);
  const { data: detail } = RequestLogStepService.useRequestLogStep("A", entry.id, {
    enabled: opened,
  });
  const args = detail ? safeParseJson(detail.tool_args) : null;
  const displayArgs = hideToolInputImages(args);
  const result = detail ? safeParseJson(detail.tool_result) : null;
  const error = detail?.error ?? entry.error;
  return (
    <details
      className="group/tool"
      onToggle={(e) => setOpened((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none list-none hover:bg-sand-50 transition-colors rounded-md">
        <ChevronDownIcon className="size-3 text-sand-400 transition-transform group-open/tool:rotate-0 -rotate-90 shrink-0" />
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-sand-100 text-sand-500 font-mono shrink-0">
          call {entry.callIndex + 1}
        </span>
        <span className="text-[13px] font-medium text-sand-800 font-mono truncate">
          {entry.toolName}
        </span>
        {hasError && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-100 text-red-600 font-medium uppercase shrink-0">
            error
          </span>
        )}
        <span className="ml-auto text-[11px] text-sand-400 tabular-nums shrink-0">
          {formatDurationMs(entry.durationMs)}
        </span>
      </summary>
      {opened && (
        <div className="mt-1 mx-1 mb-3 space-y-2">
          <div>
            <span className="text-[10px] uppercase tracking-wider text-sand-400 font-medium px-2">
              Request
            </span>
            <div className="mt-1 rounded-md bg-sand-50 p-3 overflow-auto">
              <FormattedContent text={detail ? JSON.stringify(displayArgs) : "Loading..."} />
            </div>
          </div>
          {error && (
            <div>
              <span className="text-[10px] uppercase tracking-wider text-red-500 font-medium px-2">
                Error
              </span>
              <div className="mt-1 rounded-md bg-red-50 border border-red-100 p-3 overflow-auto">
                <FormattedContent text={error} />
              </div>
            </div>
          )}
          <div>
            <span className="text-[10px] uppercase tracking-wider text-sand-400 font-medium px-2">
              Response
            </span>
            <div className="mt-1 rounded-md bg-sand-50 p-3 overflow-auto">
              <FormattedContent
                text={
                  detail
                    ? typeof result === "string"
                      ? result
                      : JSON.stringify(result)
                    : "Loading..."
                }
                markdown
              />
            </div>
          </div>
        </div>
      )}
    </details>
  );
}

function ReasoningBlock({ stepId }: { stepId: number }) {
  const [opened, setOpened] = useState(false);
  const { data: detail } = RequestLogStepService.useRequestLogStep("A", stepId, {
    enabled: opened,
  });
  const reasoningText = detail?.reasoning_text ?? null;
  return (
    <details
      className="group/reason mt-3"
      onToggle={(e) => setOpened((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="flex items-center gap-2 cursor-pointer select-none list-none">
        <ChevronDownIcon className="size-3 text-sand-400 transition-transform group-open/reason:rotate-0 -rotate-90 shrink-0" />
        <span className="text-[10px] uppercase tracking-wider text-sand-500 font-medium">
          Reasoning
        </span>
      </summary>
      {opened && (
        <div className="mt-2 rounded-md bg-white/70 border border-sand-100 p-3 overflow-auto">
          {reasoningText ? (
            <FormattedContent text={reasoningText} markdown />
          ) : !detail ? (
            <p className="text-sm text-sand-400">Loading...</p>
          ) : (
            <p className="text-sm text-sand-400">No reasoning text captured.</p>
          )}
        </div>
      )}
    </details>
  );
}

function StepTreeItem({
  entry,
  tokensPerSecEnabled,
}: {
  entry: StepTreeEntry;
  tokensPerSecEnabled: boolean;
}) {
  const generate = entry.generate;
  const hasReasoning =
    generate !== null &&
    generate.reasoningTokens !== null &&
    generate.reasoningTokens !== undefined &&
    generate.reasoningTokens > 0;
  const errorCount = entry.toolCalls.filter((toolCall) => toolCall.error).length;

  return (
    <details open className="group/step border-l border-sand-200 pl-3">
      <summary className="flex items-center gap-2 py-2 cursor-pointer select-none list-none">
        <ChevronDownIcon className="size-3.5 text-sand-400 transition-transform group-open/step:rotate-0 -rotate-90 shrink-0" />
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-sienna-100 text-sienna-700 font-mono shrink-0">
          step {entry.stepIndex + 1}
        </span>
        <span className="text-[13px] font-semibold text-sand-900">LLM call</span>
        {generate?.finishReason && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-sand-100 text-sand-500 font-mono shrink-0">
            {generate.finishReason}
          </span>
        )}
        {generate && (generate.fallbackCount ?? 0) > 0 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-caution-400/15 text-caution-500 font-medium uppercase shrink-0">
            {generate.requestedModelName} → {generate.modelName}
          </span>
        )}
        {hasReasoning && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-600 font-medium shrink-0">
            reasoning
          </span>
        )}
        {errorCount > 0 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-100 text-red-600 font-medium uppercase shrink-0">
            {errorCount} error
          </span>
        )}
        <span className="ml-auto text-[11px] text-sand-400 tabular-nums shrink-0">
          {entry.toolCalls.length} tools
        </span>
      </summary>

      <div className="ml-4 mb-4 space-y-3">
        {generate && (
          <div className="rounded-md border border-sand-100 bg-sand-50/70 p-3">
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-8 gap-x-4 gap-y-3">
              <CompactMetric label="Duration" value={formatDurationMs(generate.durationMs)} />
              <CompactMetric label="TTFT" value={formatRunTtftMs(generate.ttftMs)} />
              <CompactMetric
                label="Tokens/sec"
                value={formatTokensPerSec(
                  generate.outputTokens,
                  generate.durationMs,
                  generate.ttftMs,
                  tokensPerSecEnabled,
                )}
              />
              <CompactMetric label="Input" value={formatNum(generate.inputTokens ?? 0)} />
              <CompactMetric label="Output" value={formatNum(generate.outputTokens ?? 0)} />
              <CompactMetric label="Cache Read" value={formatNum(generate.cacheReadTokens ?? 0)} />
              <CompactMetric
                label="Cache Write"
                value={formatNum(generate.cacheCreationTokens ?? 0)}
              />
              <CompactMetric
                label="Cache 5m / 1h"
                value={`${generate.cacheCreation5mTokens === null ? "—" : formatNum(generate.cacheCreation5mTokens)} / ${generate.cacheCreation1hTokens === null ? "—" : formatNum(generate.cacheCreation1hTokens)}`}
              />
              <CompactMetric
                label="Cost"
                value={generate.costUsd === null ? "—" : formatMicroUsd(generate.costUsd)}
              />
              <CompactMetric label="Cost Source" value={generate.costSource ?? "legacy"} />
              <CompactMetric
                label="Reasoning"
                value={
                  generate.reasoningTokens !== null && generate.reasoningTokens !== undefined
                    ? formatNum(generate.reasoningTokens)
                    : "—"
                }
              />
            </div>

            {hasReasoning && <ReasoningBlock stepId={generate.id} />}
          </div>
        )}

        {entry.toolCalls.length > 0 && (
          <div className="space-y-0.5">
            {entry.toolCalls.map((toolCall) => (
              <ToolCallItem
                key={`${toolCall.stepIndex}-${toolCall.callIndex}-${toolCall.toolCallId}`}
                entry={toolCall}
              />
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

function StepTreeSection({
  steps,
  tokensPerSecEnabled,
}: {
  steps: StepTreeEntry[];
  tokensPerSecEnabled: boolean;
}) {
  const toolCallCount = steps.reduce((sum, step) => sum + step.toolCalls.length, 0);

  return (
    <Section title={`Steps (${steps.length} steps · ${toolCallCount} tool calls)`} defaultOpen>
      <div className="space-y-1">
        {steps.map((step) => (
          <StepTreeItem
            key={step.stepIndex}
            entry={step}
            tokensPerSecEnabled={tokensPerSecEnabled}
          />
        ))}
      </div>
    </Section>
  );
}

function buildStepTree(steps: RequestLogStep[]): StepTreeEntry[] {
  const grouped = new Map<number, StepTreeEntry>();

  function ensureStep(stepIndex: number): StepTreeEntry {
    const existing = grouped.get(stepIndex);
    if (existing) return existing;
    const next = { stepIndex, generate: null, toolCalls: [] };
    grouped.set(stepIndex, next);
    return next;
  }

  for (const step of steps) {
    const group = ensureStep(step.step_index);
    if (step.type === "generate") {
      group.generate = {
        id: step.id,
        stepIndex: step.step_index,
        modelName: step.model_name,
        requestedModelName: step.requested_model_name,
        fallbackCount: step.fallback_count,
        inputTokens: step.input_tokens,
        outputTokens: step.output_tokens,
        cacheReadTokens: step.cache_read_tokens,
        cacheCreationTokens: step.cache_creation_tokens,
        cacheCreation5mTokens: step.cache_creation_5m_tokens,
        cacheCreation1hTokens: step.cache_creation_1h_tokens,
        costUsd: step.cost_usd,
        costSource: step.cost_source,
        durationMs: step.duration_ms,
        ttftMs: step.ttft_ms,
        finishReason: step.finish_reason,
        reasoningTokens: step.reasoning_tokens,
      };
      continue;
    }

    if (step.type === "tool_call") {
      group.toolCalls.push({
        id: step.id,
        stepIndex: step.step_index,
        callIndex: step.tool_call_index ?? group.toolCalls.length,
        toolCallId: step.tool_call_id ?? "",
        toolName: step.tool_name ?? "",
        durationMs: step.tool_duration_ms ?? 0,
        error: step.error,
      });
    }
  }

  return [...grouped.values()]
    .map((step) => ({
      ...step,
      toolCalls: step.toolCalls.toSorted((a, b) => a.callIndex - b.callIndex),
    }))
    .toSorted((a, b) => a.stepIndex - b.stepIndex);
}

type HistoryItem = {
  type: string;
  role?: string;
  content?: unknown;
  name?: string;
  arguments?: string;
  call_id?: string;
  output?: string;
};

function historyItemBg(item: HistoryItem): string {
  if (item.type === "function_call" || item.type === "function_call_output")
    return "bg-caution-400/10";
  if (item.role === "assistant") return "bg-sage-50";
  return "bg-sand-50";
}

function historyItemLabel(item: HistoryItem): string {
  if (item.type === "function_call") return `fn: ${item.name ?? "unknown"}`;
  if (item.type === "function_call_output") return `fn result`;
  return item.role ?? item.type;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "object" && c !== null && "text" in c) return (c as { text: string }).text;
        return JSON.stringify(c);
      })
      .join("\n");
  }
  return JSON.stringify(content);
}

function MonoPre({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <pre
      className={`text-[12px] text-sand-700 whitespace-pre-wrap wrap-break-word font-mono leading-relaxed max-h-40 overflow-auto ${className ?? ""}`}
    >
      {children}
    </pre>
  );
}

function HistorySection({ history }: { history: HistoryItem[] }) {
  return (
    <Section title="History" defaultOpen={false}>
      <div className="space-y-1.5">
        {history.map((item, i) => (
          <div key={`hist-${i}`} className={`rounded-md px-3 py-2 ${historyItemBg(item)}`}>
            <div className="text-[10px] uppercase tracking-wider text-sand-500 font-medium mb-1">
              {historyItemLabel(item)}
            </div>
            {item.content !== null && item.content !== undefined && (
              <MonoPre>{extractText(item.content)}</MonoPre>
            )}
            {item.arguments && <MonoPre>{item.arguments}</MonoPre>}
            {item.output && <MonoPre>{item.output}</MonoPre>}
          </div>
        ))}
      </div>
    </Section>
  );
}

function ToolsSection({ tools }: { tools: ToolDefinitions }) {
  return (
    <Section title={`Tools (${tools.length})`} defaultOpen={false}>
      <div className="space-y-1.5">
        {tools.map((tool, i) => (
          <div key={`tool-${i}`} className="rounded-md px-3 py-2 bg-caution-400/10">
            <div className="text-[10px] uppercase tracking-wider text-sand-500 font-medium mb-1">
              fn: {tool.name}
            </div>
            {tool.description && (
              <p className="text-[12px] text-sand-700 leading-relaxed">{tool.description}</p>
            )}
            {tool.inputSchema !== undefined && tool.inputSchema !== null && (
              <MonoPre className="mt-1">{JSON.stringify(tool.inputSchema, null, 2)}</MonoPre>
            )}
          </div>
        ))}
      </div>
    </Section>
  );
}

// 서버가 생성한 type 선언·zod 표현식 텍스트의 토큰 분류. 우리가 만든 통제된
// 문법이라 하이라이트 라이브러리 없이 정규식 하나로 정확하게 나뉜다.
const TYPE_TOKEN_RE =
  /("(?:[^"\\]|\\.)*")|(\b\d+(?:\.\d+)?\b)|(\btype\b|\bz\b(?=\.))|(\b(?:string|number|boolean|null|unknown|Record)\b)|([{}[\]()<>|?:,.=])|([A-Za-z_$][\w$]*)|(\s+|.)/g;

function highlightTypeText(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let afterTypeKeyword = false;
  for (const match of text.matchAll(TYPE_TOKEN_RE)) {
    const [token, str, num, kw, builtin, punct, ident] = match;
    const key = `${match.index}-${token}`;
    if (str || num) {
      nodes.push(
        <span key={key} className="text-sage-400">
          {token}
        </span>,
      );
    } else if (kw) {
      // `type` 키워드만 다음 식별자를 타입 이름으로 승격한다. `z.`는 접두 토큰일 뿐.
      afterTypeKeyword = token === "type";
      nodes.push(
        <span key={key} className="text-sienna-400">
          {token}
        </span>,
      );
    } else if (builtin) {
      nodes.push(
        <span key={key} className="text-blue-300">
          {token}
        </span>,
      );
    } else if (punct) {
      nodes.push(
        <span key={key} className="text-sand-500">
          {token}
        </span>,
      );
    } else if (ident && afterTypeKeyword) {
      // `type` 바로 다음 식별자 = 타입 이름
      afterTypeKeyword = false;
      nodes.push(
        <span key={key} className="font-semibold text-sand-50">
          {token}
        </span>,
      );
    } else {
      nodes.push(token);
    }
  }
  return nodes;
}

// structured output 요청의 응답 타입 요약 — JSON Schema 에서 재구성한 zod 표현식이
// 기본이고, 간결한 `type` 선언으로 전환할 수 있다(refine/transform 은 직렬화 시점에
// 소실되므로 미포함). 변환은 서버가 한다 — 스키마가 없거나 변환 실패면 그리지 않는다.
function ResponseTypePanel({ id, enabled }: { id: number; enabled: boolean }) {
  const { data } = RequestLogService.useResponseTypeTs(id, { enabled });
  const [mode, setMode] = useState<"zod" | "ts">("zod");
  if (!enabled || !data) return null;
  const { zod, typescript } = data;
  if (zod === null && typescript === null) return null;

  const code = mode === "zod" ? (zod ?? typescript!) : (typescript ?? zod!);
  return (
    <div className="panel overflow-hidden">
      <div className="panel-header flex items-center px-4 py-2">
        <span className="text-[11px] uppercase tracking-wider text-sand-500 font-medium">
          Response Type
        </span>
        <div className="ml-auto flex gap-1">
          {(
            [
              { value: "zod", label: "zod", available: zod !== null },
              { value: "ts", label: "ts", available: typescript !== null },
            ] as const
          ).map((option) => (
            <button
              key={option.value}
              type="button"
              disabled={!option.available}
              className={`px-3 py-1 text-[12px] font-mono rounded-md transition-colors ${
                mode === option.value
                  ? "bg-sand-200 text-sand-700"
                  : "text-sand-400 hover:text-sand-600 disabled:text-sand-300 disabled:cursor-not-allowed"
              }`}
              onClick={() => setMode(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <div className="relative">
        <CopyButton text={code} dark />
        {/* monit 터미널(bg-sand-900)과 같은 다크 코드블록 톤 */}
        <pre className="bg-sand-900 px-4 py-3 text-[12px] text-sand-200 whitespace-pre-wrap wrap-break-word font-mono leading-relaxed max-h-64 overflow-auto">
          {highlightTypeText(code)}
        </pre>
      </div>
    </div>
  );
}

function RequestDetail({ id }: { id: number }) {
  const { data, isLoading } = RequestLogService.useRequestLog("A", id);
  const { data: stepsData } = RequestLogStepService.useRequestLogSteps("T", {
    request_log_id: id,
    num: 0,
    page: 1,
    orderBy: "id-asc" as const,
  });
  const steps = stepsData?.rows ?? [];
  const stepTree = buildStepTree(steps);

  if (isLoading) {
    return (
      <div className="max-w-6xl mx-auto space-y-4">
        <div className="h-4 w-32 bg-sand-200 rounded animate-pulse" />
        <div className="h-40 panel animate-pulse" />
        <div className="h-32 panel animate-pulse" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="max-w-6xl mx-auto">
        <Link
          to="/logs"
          className="flex items-center gap-1 text-[13px] text-sand-500 hover:text-sienna-500 mb-4"
        >
          <ArrowLeftIcon className="size-3.5" />
          Back to Logs
        </Link>
        <p className="text-sand-400 text-sm">Request not found.</p>
      </div>
    );
  }

  const toolCalls = stepTree.flatMap((step) => step.toolCalls);
  const firstImageGenerationStepId =
    toolCalls.find((toolCall) => toolCall.toolName === "image_generation")?.id ?? null;
  const hasSteps = stepTree.length > 0;
  const tokensPerSecEnabled = isTokensPerSecEnabled(data);
  const history = data.history ?? null;
  const hasHistory = history !== null && history.length > 0;
  const tools = data.tools ?? null;
  const hasTools = tools !== null && tools.length > 0;

  const promptSections = (
    <div className="space-y-4">
      <Section title="System">
        <div className="relative">
          <CopyButton text={data.system_prompt ?? "null"} />
          <FormattedContent text={data.system_prompt ?? "null"} markdown />
        </div>
      </Section>
      <Section title="User">
        <div className="space-y-3">
          <div className="relative">
            <CopyButton text={data.user_prompt ?? "null"} />
            <FormattedContent text={data.user_prompt ?? "null"} markdown />
          </div>
          <RequestInputImages stepId={firstImageGenerationStepId} />
        </div>
      </Section>
    </div>
  );

  return (
    <div className={`mx-auto space-y-4 ${hasSteps ? "max-w-[120rem]" : "max-w-6xl"}`}>
      <Link
        to="/logs"
        className="inline-flex items-center gap-1 text-[13px] text-sand-500 hover:text-sienna-500 transition-colors"
      >
        <ArrowLeftIcon className="size-3.5" />
        Back to Logs
      </Link>

      <HeaderBar data={data} />

      {data.error_message && <ErrorPanel message={data.error_message} />}

      {hasHistory && <HistorySection history={history} />}

      {hasTools && <ToolsSection tools={tools} />}

      {hasSteps ? (
        // 좁은 화면에서는 두 칼럼이 각각 절반으로 눌려 프롬프트도 지표도 못 읽는다.
        // 세로로 쌓되 Steps 를 먼저 보여준다 — 프롬프트 전문보다 실행 결과를 먼저 확인한다.
        <div className="flex flex-col lg:flex-row gap-4 items-stretch lg:items-start">
          <div className="order-1 lg:order-2 flex-1 min-w-0 space-y-4">
            <ResponseTypePanel id={id} enabled={!!data.json_schema} />
            <StepTreeSection steps={stepTree} tokensPerSecEnabled={tokensPerSecEnabled} />
          </div>
          <div className="order-2 lg:order-1 flex-1 min-w-0">{promptSections}</div>
        </div>
      ) : (
        <>
          <ResponseTypePanel id={id} enabled={!!data.json_schema} />
          {promptSections}
        </>
      )}

      <Section title="Response">
        <div className="relative">
          <CopyButton text={data.response} />
          <FormattedContent text={data.response} markdown />
        </div>
      </Section>

      <MetricsPanel data={data} toolCallCount={toolCalls.length} />

      <div className="pb-8" />
    </div>
  );
}
