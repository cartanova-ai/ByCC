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
        <div className="prose prose-sm prose-qgrid max-w-none">
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
      <dd className="text-[15px] font-semibold text-sand-800 tabular-nums mt-0.5">{value}</dd>
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
  const status = (data as Record<string, unknown>).status as string | undefined;

  return (
    <div className="panel overflow-hidden px-5 py-3 flex items-center gap-2">
      <span className="text-[15px] font-semibold text-sand-900">
        {data.model_name ?? "Unknown model"}
      </span>
      {status && status !== "succeeded" && (
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium uppercase ${STATUS_STYLE[status] ?? "bg-sand-100 text-sand-500"}`}
        >
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
      <span className="ml-auto text-[11px] text-sand-400">{data.token_name}</span>
    </div>
  );
}

function MetricsPanel({ data, toolCallCount }: { data: RequestLog; toolCallCount: number }) {
  const denom = data.input_tokens;
  const cacheHitRate = denom > 0 ? `${Math.round((data.cache_read_tokens / denom) * 100)}%` : "—";

  return (
    <div className="panel overflow-hidden px-5 py-3 space-y-3">
      <div className="grid grid-cols-4 gap-x-6">
        <Metric label="Duration" value={`${(data.duration_ms / 1000).toFixed(1)}s`} />
        <Metric label="Cost" value={data.cost_usd !== null ? formatMicroUsd(data.cost_usd) : "—"} />
        <Metric label="Tool Calls" value={`${toolCallCount}회`} />
        <Metric label="Cache Hit" value={cacheHitRate} />
      </div>
      <div className="border-t border-sand-100/60 pt-3 grid grid-cols-4 gap-x-6">
        <Metric label="Input" value={formatNum(data.input_tokens)} />
        <Metric label="Output" value={formatNum(data.output_tokens)} />
        <Metric label="Cache Read" value={formatNum(data.cache_read_tokens)} />
        <Metric label="Cache Write" value={formatNum(data.cache_creation_tokens)} />
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

type GenerateStepEntry = {
  id: number;
  stepIndex: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  durationMs: number | null;
  finishReason: string | null;
  reasoningTokens: number | null;
};

type StepTreeEntry = {
  stepIndex: number;
  generate: GenerateStepEntry | null;
  toolCalls: ToolCallEntry[];
};

function formatDurationMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function CompactMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-sand-400 font-medium">{label}</div>
      <div className="mt-0.5 text-[13px] font-semibold text-sand-800 tabular-nums">{value}</div>
    </div>
  );
}

function ToolCallItem({ entry }: { entry: ToolCallEntry }) {
  const hasError = !!entry.error;
  const [opened, setOpened] = useState(false);
  const { data: detail } = RequestLogStepService.useRequestLogStep("A", entry.id, {
    enabled: opened,
  });
  const args = detail ? safeParseJson(detail.tool_args) : null;
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
              <FormattedContent text={detail ? JSON.stringify(args) : "Loading..."} />
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

function StepTreeItem({ entry }: { entry: StepTreeEntry }) {
  const generate = entry.generate;
  const hasReasoning =
    generate != null && generate.reasoningTokens != null && generate.reasoningTokens > 0;
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
            <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
              <CompactMetric label="Duration" value={formatDurationMs(generate.durationMs)} />
              <CompactMetric label="Input" value={formatNum(generate.inputTokens ?? 0)} />
              <CompactMetric label="Output" value={formatNum(generate.outputTokens ?? 0)} />
              <CompactMetric label="Cache Read" value={formatNum(generate.cacheReadTokens ?? 0)} />
              <CompactMetric
                label="Cache Write"
                value={formatNum(generate.cacheCreationTokens ?? 0)}
              />
              <CompactMetric
                label="Reasoning"
                value={generate.reasoningTokens != null ? formatNum(generate.reasoningTokens) : "—"}
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

function StepTreeSection({ steps }: { steps: StepTreeEntry[] }) {
  const toolCallCount = steps.reduce((sum, step) => sum + step.toolCalls.length, 0);

  return (
    <Section title={`Steps (${steps.length} steps · ${toolCallCount} tool calls)`} defaultOpen>
      <div className="space-y-1">
        {steps.map((step) => (
          <StepTreeItem key={step.stepIndex} entry={step} />
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
        inputTokens: step.input_tokens,
        outputTokens: step.output_tokens,
        cacheReadTokens: step.cache_read_tokens,
        cacheCreationTokens: step.cache_creation_tokens,
        durationMs: step.duration_ms,
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
  const { data: stepsData } = RequestLogStepService.useRequestLogSteps("T", {
    request_log_id: id,
    num: 0,
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

  const stepTree = buildStepTree(steps);
  const toolCalls = stepTree.flatMap((step) => step.toolCalls);
  const hasSteps = stepTree.length > 0;
  const history = data.history ?? null;
  const hasHistory = history !== null && history.length > 0;

  const promptSections = (
    <div className="space-y-4">
      <Section title="System">
        <div className="relative">
          <CopyButton text={data.system_prompt ?? "null"} />
          <FormattedContent text={data.system_prompt ?? "null"} markdown />
        </div>
      </Section>
      <Section title="User">
        <div className="relative">
          <CopyButton text={data.user_prompt ?? "null"} />
          <FormattedContent text={data.user_prompt ?? "null"} markdown />
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

      {hasSteps ? (
        <div className="flex gap-4 items-start">
          <div className="flex-1 min-w-0">{promptSections}</div>
          <div className="flex-1 min-w-0 space-y-4">
            <StepTreeSection steps={stepTree} />
          </div>
        </div>
      ) : (
        promptSections
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
