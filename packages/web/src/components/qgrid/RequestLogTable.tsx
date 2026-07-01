import { Link, useNavigate } from "@tanstack/react-router";
import ChevronLeftIcon from "~icons/lucide/chevron-left";
import ChevronRightIcon from "~icons/lucide/chevron-right";

import { cacheHitRate, formatMicroUsd, formatUsd } from "@/lib/cost";
import { type LogsSearch } from "@/routes/logs";
import { QgridService, RequestLogService, TokenService } from "@/services/services.generated";

const PAGE_SIZE = 50;
const UNASSIGNED = "__unassigned__";

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

function formatNum(n: number): string {
  return n.toLocaleString();
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// TTFT 는 보통 1초 미만이라 초 단위로 뭉개면 "0s" 가 된다. ms/s 적응형으로 표기.
// ttft_ms 는 0-fallback(non-null)이라 duration 과 마찬가지로 0 도 그대로 보여준다.
function formatTtft(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

const COLUMNS: { label: string; align: "left" | "right"; width?: string }[] = [
  { label: "ID", align: "left", width: "w-12" },
  { label: "Date", align: "left", width: "w-20" },
  { label: "Project", align: "left", width: "w-20" },
  { label: "Token", align: "left", width: "w-24" },
  { label: "Model", align: "left", width: "w-20" },
  { label: "TTFT", align: "left", width: "w-16" },
  { label: "Duration", align: "left", width: "w-20" },
  { label: "In", align: "left", width: "w-16" },
  { label: "Out", align: "left", width: "w-20" },
  { label: "C.Read", align: "left", width: "w-20" },
  { label: "C.Write", align: "left", width: "w-20" },
  { label: "Hit", align: "left", width: "w-14" },
  { label: "Tools", align: "left", width: "w-14" },
  { label: "Cost", align: "left", width: "w-20" },
];

interface RequestLogTableProps {
  search: LogsSearch;
  onSearchChange: (next: LogsSearch) => void;
}

export function RequestLogTable({ search, onSearchChange }: RequestLogTableProps) {
  const navigate = useNavigate();
  const page = search.page ?? 1;
  const tokenFilter = search.token ?? "";
  const projectFilter = search.project ?? "";

  const { data: tokensData } = TokenService.useTokens("A");
  const tokenNames = (tokensData?.rows ?? []).map((t) => t.name).filter(Boolean);

  const { data: projectData } = QgridService.useProjectNames();
  const projectNames = projectData?.names ?? [];

  const projectFilterParam = (() => {
    if (projectFilter === UNASSIGNED) return { project_name_is_null: true as const };
    if (projectFilter) return { project_name: projectFilter };
    return {};
  })();

  const { data, isLoading } = RequestLogService.useRequestLogs("P", {
    num: PAGE_SIZE,
    page,
    orderBy: "id-desc" as const,
    ...(tokenFilter ? { token_name: tokenFilter } : {}),
    ...projectFilterParam,
  });
  const { data: costData } = QgridService.useTotalCost(tokenFilter || undefined);
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  const updateFilter = (patch: Partial<LogsSearch>) => {
    onSearchChange({ ...search, ...patch, page: 1 });
  };

  return (
    <div className="panel overflow-hidden">
      <div className="panel-header flex items-center gap-3 px-5 py-2.5 flex-wrap">
        {tokenNames.length > 0 && (
          <select
            value={tokenFilter}
            onChange={(e) => updateFilter({ token: e.target.value || undefined })}
            className="border border-sand-200/80 rounded-lg px-2.5 py-1.5 text-[11px] text-sand-700 bg-sand-50/50 focus:outline-none focus:border-sienna-300"
          >
            <option value="">All Tokens</option>
            {tokenNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        )}
        <select
          value={projectFilter}
          onChange={(e) => updateFilter({ project: e.target.value || undefined })}
          className="border border-sand-200/80 rounded-lg px-2.5 py-1.5 text-[11px] text-sand-700 bg-sand-50/50 focus:outline-none focus:border-sienna-300"
        >
          <option value="">All Projects</option>
          <option value={UNASSIGNED}>(unassigned)</option>
          {projectNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <div className="flex-1" />
        <span className="text-[11px] text-sand-400">{total} results</span>
        <span className="text-[11px] tabular-nums font-medium text-sienna-600">
          {formatUsd(costData?.usd ?? 0)}
        </span>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={`skel-${i}`} className="h-8 bg-sand-100 rounded animate-pulse" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="text-sand-400 text-center py-12 text-sm">No requests yet.</div>
      ) : (
        <>
          <div className="overflow-x-auto px-5 py-3">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-sand-100/60">
                  {COLUMNS.map((col) => {
                    const padX =
                      col.label === "Duration" ? "pl-5 pr-3" : col.width ? "px-4" : "px-3";
                    return (
                      <th
                        key={col.label}
                        className={`text-${col.align} ${col.width ?? ""} ${col.width ? "whitespace-nowrap" : ""} ${padX} py-1.5 text-[10px] uppercase text-sand-400 font-medium`}
                      >
                        {col.label}
                      </th>
                    );
                  })}
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody className="divide-y divide-sand-100/60">
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    className="transition-colors duration-150 hover:bg-sand-100/60 cursor-pointer"
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey) {
                        window.open(`/requests/show?id=${row.id}`, "_blank");
                        return;
                      }
                      navigate({ to: "/requests/show", search: { id: row.id } });
                    }}
                  >
                    <td className="px-4 py-1.5 whitespace-nowrap">
                      <Link
                        to="/requests/show"
                        search={{ id: row.id }}
                        onClick={(e) => e.stopPropagation()}
                        className="text-xs text-sand-500 tabular-nums hover:text-sienna-500"
                      >
                        {row.id}
                      </Link>
                    </td>
                    <td className="px-4 py-1.5 whitespace-nowrap">
                      <span className="text-xs text-sand-400 tabular-nums">
                        {formatDateTime(row.created_at as unknown as string)}
                      </span>
                    </td>
                    <td className="px-4 py-1.5 whitespace-nowrap">
                      <span className="text-xs text-sand-600">{row.project_name ?? "—"}</span>
                    </td>
                    <td className="px-4 py-1.5 whitespace-nowrap">
                      <span className="text-xs text-sand-500">{row.token_name}</span>
                    </td>
                    <td className="px-4 py-1.5 whitespace-nowrap">
                      <span className="text-xs text-sand-500">{row.model_name ?? "—"}</span>
                    </td>
                    <td className="px-4 py-1.5 text-left tabular-nums text-sand-500 whitespace-nowrap">
                      {formatTtft(row.ttft_ms)}
                    </td>
                    <td className="pl-5 pr-3 py-1.5 text-left tabular-nums text-sand-500 whitespace-nowrap">
                      {formatDuration(row.duration_ms)}
                    </td>
                    <td className="px-3 py-1.5 text-left tabular-nums text-sand-700">
                      {formatNum(row.input_tokens)}
                    </td>
                    <td className="px-3 py-1.5 text-left tabular-nums text-sand-700">
                      {formatNum(row.output_tokens)}
                    </td>
                    <td className="px-3 py-1.5 text-left tabular-nums text-sand-700">
                      {formatNum(row.cache_read_tokens)}
                    </td>
                    <td className="px-3 py-1.5 text-left tabular-nums text-sand-700">
                      {formatNum(row.cache_creation_tokens)}
                    </td>
                    <td className="px-3 py-1.5 text-left tabular-nums text-sand-700">
                      {cacheHitRate(row)}
                    </td>
                    <td className="px-3 py-1.5 text-left tabular-nums text-sand-500">
                      {row.tool_call_count > 0 ? row.tool_call_count : "—"}
                    </td>
                    <td className="px-3 py-1.5 text-left tabular-nums text-sand-700">
                      {row.cost_usd !== null ? formatMicroUsd(row.cost_usd) : "—"}
                    </td>
                    <td className="px-2 py-1.5">
                      <ChevronRightIcon className="size-4 text-sand-400" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-3 px-5 py-2.5 border-t border-sand-100/60">
              <button
                type="button"
                className="p-1 rounded text-sand-400 hover:text-sand-600 disabled:opacity-30 transition-colors"
                disabled={page === 1}
                onClick={() => onSearchChange({ ...search, page: page - 1 })}
              >
                <ChevronLeftIcon className="size-4" />
              </button>
              <span className="text-[11px] text-sand-400 tabular-nums">
                {page} / {totalPages}
              </span>
              <button
                type="button"
                className="p-1 rounded text-sand-400 hover:text-sand-600 disabled:opacity-30 transition-colors"
                disabled={page === totalPages}
                onClick={() => onSearchChange({ ...search, page: page + 1 })}
              >
                <ChevronRightIcon className="size-4" />
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
