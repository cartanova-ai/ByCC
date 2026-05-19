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

import { RequestLogService } from "@/services/services.generated";

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

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function tryParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
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

function RequestDetail({ id }: { id: number }) {
  const { data, isLoading } = RequestLogService.useRequestLog("A", id);

  if (isLoading) {
    return (
      <div className="max-w-4xl mx-auto space-y-4">
        <div className="h-4 w-32 bg-sand-200 rounded animate-pulse" />
        <div className="h-40 bg-white border border-sand-200/80 rounded-xl animate-pulse" />
        <div className="h-32 bg-white border border-sand-200/80 rounded-xl animate-pulse" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="max-w-4xl mx-auto">
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

  const denom = data.input_tokens + data.cache_read_tokens + data.cache_creation_tokens;
  const cacheHitRate = denom > 0 ? `${Math.round((data.cache_read_tokens / denom) * 100)}%` : "—";

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <Link
        to="/logs"
        className="inline-flex items-center gap-1 text-[13px] text-sand-500 hover:text-sienna-500 transition-colors"
      >
        <ArrowLeftIcon className="size-3.5" />
        Back to Logs
      </Link>

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

      <Section title="Response">
        <div className="relative">
          <CopyButton text={data.response} />
          <FormattedContent text={data.response} markdown />
        </div>
      </Section>

      <Section title="Token Breakdown">
        <div className="px-1">
          <table className="w-full text-sm tabular-nums">
            <tbody className="text-sand-700">
              <tr>
                <td className="py-1.5">Input</td>
                <td className="py-1.5 text-right font-medium text-sand-800">
                  {formatNum(data.input_tokens)}
                </td>
              </tr>
              <tr>
                <td className="py-1.5">Output</td>
                <td className="py-1.5 text-right font-medium text-sand-800">
                  {formatNum(data.output_tokens)}
                </td>
              </tr>
              <tr>
                <td className="py-1.5">Cache Read</td>
                <td className="py-1.5 text-right font-medium text-sand-800">
                  {formatNum(data.cache_read_tokens)}
                </td>
              </tr>
              <tr>
                <td className="py-1.5">Cache Write</td>
                <td className="py-1.5 text-right font-medium text-sand-800">
                  {formatNum(data.cache_creation_tokens)}
                </td>
              </tr>
              <tr className="border-t border-sand-200/60">
                <td className="py-1.5 font-medium text-sand-800">Cache Hit Rate</td>
                <td className="py-1.5 text-right font-medium text-sienna-500 text-base">
                  {cacheHitRate}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Info">
        <div className="px-1">
          <table className="w-full text-sm">
            <tbody className="text-sand-700">
              <tr>
                <td className="py-1.5 text-sand-500">Project</td>
                <td className="py-1.5 text-right font-medium text-sand-800">
                  {data.project_name ?? "—"}
                </td>
              </tr>
              <tr>
                <td className="py-1.5 text-sand-500">Token</td>
                <td className="py-1.5 text-right font-medium text-sand-800">{data.token_name}</td>
              </tr>
              <tr>
                <td className="py-1.5 text-sand-500">Model</td>
                <td className="py-1.5 text-right font-medium text-sand-800">
                  {data.model_name ?? "—"}
                </td>
              </tr>
              <tr>
                <td className="py-1.5 text-sand-500">Time</td>
                <td className="py-1.5 text-right font-medium text-sand-800">
                  {formatDateTime(data.created_at as unknown as string)}
                </td>
              </tr>
              <tr>
                <td className="py-1.5 text-sand-500">Duration</td>
                <td className="py-1.5 text-right font-medium text-sand-800">
                  {(data.duration_ms / 1000).toFixed(1)}s
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Section>

      <div className="pb-8" />
    </div>
  );
}
