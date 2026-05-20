import { createFileRoute, Link } from "@tanstack/react-router";
import JsonView from "@uiw/react-json-view";
import { lightTheme } from "@uiw/react-json-view/light";
import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { z } from "zod";
import ArrowLeftIcon from "~icons/lucide/arrow-left";
import CheckIcon from "~icons/lucide/check";
import ChevronDownIcon from "~icons/lucide/chevron-down";
import CopyIcon from "~icons/lucide/copy";

import { formatMicroUsd } from "@/lib/cost";
import { RequestLogService, RequestLogStepService } from "@/services/services.generated";
import { type RequestLogSubsetMapping } from "@/services/sonamu.generated";

type RequestLog = RequestLogSubsetMapping["A"];

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

function tryParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
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

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
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
      className="absolute top-2 right-2 p-1 rounded text-sand-400 hover:text-sand-600 transition-colors"
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

function FormattedContent({ text, markdown }: { text: string; markdown?: boolean }) {
  const parsed = tryParseJson(text);
  const [mode, setMode] = useState<"pretty" | "plain">("pretty");

  if (parsed === null) {
    if (markdown) {
      return (
        <div className="prose prose-sm prose-sand max-w-none">
          <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
        </div>
      );
    }
    return (
      <pre className="text-sm text-sand-800 whitespace-pre-wrap wrap-break-word font-mono leading-relaxed">
        {text}
      </pre>
    );
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
          value={parsed as object}
          style={lightTheme}
          displayDataTypes={false}
          enableClipboard
          collapsed={false}
        />
      ) : (
        <pre className="text-sm text-sand-800 whitespace-pre-wrap wrap-break-word font-mono leading-relaxed">
          {JSON.stringify(parsed, null, 2)}
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
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-sand-400 font-medium">{label}</dt>
      <dd className="text-[13px] font-medium text-sand-800 tabular-nums mt-0.5">{value}</dd>
    </div>
  );
}

const STATUS_STYLE: Record<string, string> = {
  running: "bg-blue-100 text-blue-600",
  succeeded: "bg-sage-100 text-sage-600",
  error: "bg-red-100 text-red-600",
  aborted: "bg-caution-400/15 text-caution-500",
};

function HeaderBar({ data }: { data: RequestLog }) {
  const status = (data as Record<string, unknown>).status as string | undefined;

  return (
    <div className="panel overflow-hidden px-5 py-3 flex items-center gap-2">
      <span className="text-[15px] font-semibold text-sand-900">
        {data.model_name ?? "Unknown model"}
      </span>
      {status && status !== "succeeded" && (
        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium uppercase ${STATUS_STYLE[status] ?? "bg-sand-100 text-sand-500"}`}>
          {status}
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
      <span className="ml-auto text-[11px] text-sand-400">
        {data.token_name}
      </span>
    </div>
  );
}

function MetricsPanel({ data, toolCallCount }: { data: RequestLog; toolCallCount: number }) {
  const denom = data.input_tokens + data.cache_read_tokens + data.cache_creation_tokens;
  const cacheHitRate = denom > 0 ? `${Math.round((data.cache_read_tokens / denom) * 100)}%` : "—";

  return (
    <div className="panel overflow-hidden">
      <div className="px-5 py-3 grid grid-cols-3 gap-x-8 gap-y-2 border-b border-sand-100/60">
        <Metric label="Duration" value={`${(data.duration_ms / 1000).toFixed(1)}s`} />
        <Metric
          label="Cost"
          value={data.cost_usd !== null ? formatMicroUsd(data.cost_usd) : "—"}
        />
        <Metric label="Tool Calls" value={`${toolCallCount}회`} />
      </div>

      <div className="px-5 py-3">
        <div className="grid grid-cols-4 gap-x-6 gap-y-1.5">
          <Metric label="Input" value={formatNum(data.input_tokens)} />
          <Metric label="Output" value={formatNum(data.output_tokens)} />
          <Metric label="Cache Read" value={formatNum(data.cache_read_tokens)} />
          <Metric label="Cache Write" value={formatNum(data.cache_creation_tokens)} />
        </div>
        <div className="mt-2 pt-2 border-t border-sand-100/60 flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wider text-sand-400 font-medium">
            Cache Hit Rate
          </span>
          <span className="text-[15px] font-semibold text-sienna-500 tabular-nums">
            {cacheHitRate}
          </span>
        </div>
      </div>
    </div>
  );
}

type ToolCallEntry = {
  index: number;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
  durationMs: number;
};

function ToolCallItem({ entry }: { entry: ToolCallEntry }) {
  return (
    <details className="group/tool">
      <summary className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none list-none hover:bg-sand-50 transition-colors rounded-md">
        <ChevronDownIcon className="size-3 text-sand-400 transition-transform group-open/tool:rotate-0 -rotate-90 shrink-0" />
        <span className="text-[11px] text-sand-400 tabular-nums shrink-0">[{entry.index + 1}]</span>
        <span className="text-[13px] font-medium text-sand-800 font-mono truncate">
          {entry.toolName}
        </span>
        <span className="ml-auto text-[11px] text-sand-400 tabular-nums shrink-0">
          {entry.durationMs >= 1000
            ? `${(entry.durationMs / 1000).toFixed(1)}s`
            : `${entry.durationMs}ms`}
        </span>
      </summary>
      <div className="ml-5 mr-3 mb-2 space-y-2">
        <div>
          <span className="text-[10px] uppercase tracking-wider text-sand-400 font-medium">
            Request
          </span>
          <div className="mt-1 rounded-md bg-sand-50 p-3 overflow-auto max-h-60">
            <FormattedContent text={JSON.stringify(entry.args)} />
          </div>
        </div>
        <div>
          <span className="text-[10px] uppercase tracking-wider text-sand-400 font-medium">
            Response
          </span>
          <div className="mt-1 rounded-md bg-sand-50 p-3 overflow-auto max-h-60">
            <FormattedContent
              text={typeof entry.result === "string" ? entry.result : JSON.stringify(entry.result)}
            />
          </div>
        </div>
      </div>
    </details>
  );
}

function ToolCallsSection({ toolCalls }: { toolCalls: ToolCallEntry[] }) {
  return (
    <Section title={`Tool 호출 (${toolCalls.length}회)`} defaultOpen>
      <div className="space-y-0.5 -mx-1">
        {toolCalls.map((entry) => (
          <ToolCallItem key={entry.toolCallId} entry={entry} />
        ))}
      </div>
    </Section>
  );
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
  if (item.type === "function_call" || item.type === "function_call_output") return "bg-caution-400/10";
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

function HistorySection({ history }: { history: HistoryItem[] }) {
  return (
    <Section title="History" defaultOpen={false}>
      <div className="space-y-1.5">
        {history.map((item, i) => (
          <div key={`hist-${i}`} className={`rounded-md px-3 py-2 ${historyItemBg(item)}`}>
            <div className="text-[10px] uppercase tracking-wider text-sand-500 font-medium mb-1">
              {historyItemLabel(item)}
            </div>
            {item.content != null && (
              <pre className="text-[12px] text-sand-700 whitespace-pre-wrap wrap-break-word font-mono leading-relaxed max-h-40 overflow-auto">
                {extractText(item.content)}
              </pre>
            )}
            {item.arguments && (
              <pre className="text-[12px] text-sand-700 whitespace-pre-wrap wrap-break-word font-mono leading-relaxed max-h-40 overflow-auto">
                {item.arguments}
              </pre>
            )}
            {item.output && (
              <pre className="text-[12px] text-sand-700 whitespace-pre-wrap wrap-break-word font-mono leading-relaxed max-h-40 overflow-auto">
                {item.output}
              </pre>
            )}
          </div>
        ))}
      </div>
    </Section>
  );
}

function RequestDetail({ id }: { id: number }) {
  const { data, isLoading } = RequestLogService.useRequestLog("A", id);
  const { data: stepsData } = RequestLogStepService.useRequestLogSteps("A", {
    request_log_id: id,
    num: 100,
    page: 1,
    orderBy: "id-asc" as const,
  });

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

  const steps = stepsData?.rows ?? [];

  const toolCalls: ToolCallEntry[] = steps
    .filter((s) => s.type === "tool_call")
    .map((s) => ({
      index: s.tool_call_index ?? 0,
      toolCallId: s.tool_call_id ?? "",
      toolName: s.tool_name ?? "",
      args: safeParseJson(s.tool_args) as Record<string, unknown>,
      result: safeParseJson(s.tool_result),
      durationMs: s.tool_duration_ms ?? 0,
    }));
  const hasToolCalls = toolCalls.length > 0;
  const history = data.history ?? null;
  const hasHistory = history !== null && history.length > 0;

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <Link
        to="/logs"
        className="inline-flex items-center gap-1 text-[13px] text-sand-500 hover:text-sienna-500 transition-colors"
      >
        <ArrowLeftIcon className="size-3.5" />
        Back to Logs
      </Link>

      <HeaderBar data={data} />

      {hasHistory && <HistorySection history={history} />}

      {hasToolCalls ? (
        <div className="grid grid-cols-2 gap-4 items-start">
          <div className="space-y-4">
            <Section title="System">
              <div className="relative">
                <CopyButton text={data.system_prompt ?? "null"} />
                <FormattedContent text={data.system_prompt ?? "null"} />
              </div>
            </Section>
            <Section title="User">
              <div className="relative">
                <CopyButton text={data.user_prompt ?? "null"} />
                <FormattedContent text={data.user_prompt ?? "null"} />
              </div>
            </Section>
          </div>
          <ToolCallsSection toolCalls={toolCalls} />
        </div>
      ) : (
        <div className="space-y-4">
          <Section title="System">
            <div className="relative">
              <CopyButton text={data.system_prompt ?? "null"} />
              <FormattedContent text={data.system_prompt ?? "null"} />
            </div>
          </Section>
          <Section title="User">
            <div className="relative">
              <CopyButton text={data.user_prompt ?? "null"} />
              <FormattedContent text={data.user_prompt ?? "null"} />
            </div>
          </Section>
        </div>
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
