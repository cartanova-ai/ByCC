import { Link, useNavigate } from "@tanstack/react-router";
import ChevronLeftIcon from "~icons/lucide/chevron-left";
import ChevronRightIcon from "~icons/lucide/chevron-right";

import { cacheHitRate, formatMicroUsd, formatUsd } from "@/lib/cost";
import { type LogsSearch } from "@/routes/logs";
import { QgridService, RequestLogService, TokenService } from "@/services/services.generated";
import { type RequestLogOrderBy } from "@/services/sonamu.generated";

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

function RequestModel({
  status,
  requestedModel,
  servedModel,
  fallbackCount,
}: {
  status: string;
  requestedModel: string | null;
  servedModel: string | null;
  fallbackCount: number | null;
}) {
  if (status === "running") {
    return (
      <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-600 font-medium whitespace-nowrap">
        실행 중
      </span>
    );
  }

  const hasFallback =
    requestedModel !== null && servedModel !== null && requestedModel !== servedModel;
  const hasRequestedOnly = requestedModel !== null && servedModel === null;

  return (
    <>
      <span className="text-xs text-sand-500">
        {hasFallback
          ? `${requestedModel} → ${servedModel}`
          : (servedModel ?? requestedModel ?? "—")}
      </span>
      {hasRequestedOnly && <span className="ml-1 text-[9px] text-sand-400">요청</span>}
      {(fallbackCount ?? 0) > 0 && (
        <span className="ml-1 text-[9px] text-caution-500">×{fallbackCount}</span>
      )}
    </>
  );
}

// request_logs.ttft_ms stores 0 as the run-level "unknown/no measured TTFT" fallback.
// Non-zero TTFT is usually sub-second, so use adaptive ms/s formatting.
function formatTtft(ms: number): string {
  if (ms <= 0) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

// sortKey 가 있는 컬럼만 헤더 클릭으로 정렬된다. Project/Token/Model 은 필터가 그 역할을
// 하고, Hit/Tools 는 저장 컬럼이 아닌 파생값이라 정렬 대상에서 뺀다.
const COLUMNS: {
  label: string;
  align: "left" | "right";
  width?: string;
  sortKey?: string;
}[] = [
  { label: "ID", align: "left", width: "w-12", sortKey: "id" },
  { label: "Date", align: "left", width: "w-20", sortKey: "created_at" },
  { label: "Project", align: "left", width: "w-20" },
  { label: "Token", align: "left", width: "w-24" },
  { label: "Model", align: "left", width: "w-20" },
  // 숫자는 오른쪽 정렬해야 자릿수가 세로로 맞는다 — 6,317 과 34,897 이 왼쪽 정렬이면
  // 끝자리가 어긋나 열이 들쭉날쭉해 보인다.
  { label: "TTFT", align: "right", width: "w-16", sortKey: "ttft_ms" },
  { label: "Duration", align: "right", width: "w-20", sortKey: "duration_ms" },
  { label: "In", align: "right", width: "w-16", sortKey: "input_tokens" },
  { label: "Out", align: "right", width: "w-20", sortKey: "output_tokens" },
  { label: "C.Read", align: "right", width: "w-20", sortKey: "cache_read_tokens" },
  { label: "C.Write", align: "right", width: "w-20", sortKey: "cache_creation_tokens" },
  { label: "Hit", align: "right", width: "w-14" },
  { label: "Tools", align: "right", width: "w-14" },
  { label: "Cost", align: "right", width: "w-20", sortKey: "cost_usd" },
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
  const modelFilter = search.model ?? "";

  const { data: tokensData } = TokenService.useTokens("A");
  const tokenNames = (tokensData?.rows ?? []).map((t) => t.name).filter(Boolean);

  const { data: projectData } = QgridService.useProjectNames();
  const projectNames = projectData?.names ?? [];

  const { data: modelData } = QgridService.useModelNames();
  const modelNames = modelData?.names ?? [];

  const projectFilterParam = (() => {
    if (projectFilter === UNASSIGNED) return { project_name_is_null: true as const };
    if (projectFilter) return { project_name: projectFilter };
    return {};
  })();

  // 목록과 비용이 같은 필터를 보도록 한 객체를 공유한다.
  const listFilters = {
    ...(tokenFilter ? { token_name: tokenFilter } : {}),
    ...projectFilterParam,
    ...(modelFilter ? { model_name: modelFilter } : {}),
    ...(search.broken ? { response_json_broken: true } : {}),
  };

  const sort = search.sort ?? "id-desc";
  const separator = sort.lastIndexOf("-");
  const sortColumn = sort.slice(0, separator);
  const sortDirection = sort.slice(separator + 1) === "asc" ? "asc" : "desc";

  const { data, isLoading } = RequestLogService.useRequestLogs("P", {
    num: PAGE_SIZE,
    page,
    orderBy: sort as RequestLogOrderBy,
    ...listFilters,
  });
  const { data: costData } = QgridService.useTotalCost({ num: 0, page: 1, ...listFilters });
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  const updateFilter = (patch: Partial<LogsSearch>) => {
    onSearchChange({ ...search, ...patch, page: 1 });
  };

  return (
    <div className="panel overflow-hidden">
      <div className="panel-header flex items-center gap-2 px-3 py-2.5 flex-wrap sm:gap-3 sm:px-5">
        {/* 선택지가 없어도 셀렉트를 없애지 않는다 — 필터 줄이 통째로 사라지면 기능이
            빠진 것처럼 보인다. 비활성 상태로 자리를 지킨다. */}
        <select
          value={tokenFilter}
          onChange={(e) => updateFilter({ token: e.target.value || undefined })}
          disabled={tokenNames.length === 0}
          className="border border-sand-200/80 rounded-lg px-2.5 py-1.5 text-[11px] text-sand-700 bg-sand-50/50 focus:outline-none focus:border-sienna-300 disabled:text-sand-300 disabled:cursor-not-allowed"
        >
          <option value="">{tokenNames.length > 0 ? "All Tokens" : "Tokens —"}</option>
          {tokenNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
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
        <select
          value={modelFilter}
          onChange={(e) => updateFilter({ model: e.target.value || undefined })}
          disabled={modelNames.length === 0}
          className="border border-sand-200/80 rounded-lg px-2.5 py-1.5 text-[11px] text-sand-700 bg-sand-50/50 focus:outline-none focus:border-sienna-300 disabled:text-sand-300 disabled:cursor-not-allowed"
        >
          <option value="">{modelNames.length > 0 ? "All Models" : "Models —"}</option>
          {modelNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <button
          type="button"
          data-active={search.broken === true}
          onClick={() => updateFilter({ broken: search.broken ? undefined : true })}
          // structured 응답이 JSON 파싱에 실패한 행만. 과거 행(컬럼 도입 전)은 null 이라
          // 이 필터에 잡히지 않는다 — 도입 이후 기록부터 유효하다.
          className="rounded-lg border border-sand-200/80 bg-sand-50/50 px-2.5 py-1.5 text-[11px] text-sand-700 transition-colors hover:border-caution-500/40 data-[active=true]:border-caution-500/60 data-[active=true]:bg-caution-500/10 data-[active=true]:font-medium data-[active=true]:text-caution-500"
        >
          Broken JSON
        </button>
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
          <div className="overflow-x-auto px-3 py-3 sm:px-5">
            {/* 컬럼이 14개라 좁은 화면에서 표가 뷰포트를 넘는다. min-w 로 표를 온전히
                유지하고 이 래퍼만 가로 스크롤시킨다. */}
            <table className="w-full min-w-[900px] text-[13px]">
              <thead>
                <tr className="border-b border-sand-100/60">
                  {COLUMNS.map((col) => {
                    const padX =
                      col.label === "Duration" ? "pl-5 pr-3" : col.width ? "px-4" : "px-3";
                    const active = col.sortKey === sortColumn;
                    return (
                      <th
                        key={col.label}
                        // Tailwind 는 `text-${col.align}` 같은 동적 조합을 스캔하지 못한다.
                        // 완성된 클래스명을 그대로 쓴다.
                        className={`${col.align === "right" ? "text-right" : "text-left"} ${col.width ?? ""} ${col.width ? "whitespace-nowrap" : ""} ${padX} py-1.5 text-[10px] uppercase font-medium ${active ? "text-sienna-600" : "text-sand-400"}`}
                      >
                        {col.sortKey ? (
                          <button
                            type="button"
                            // 같은 컬럼을 다시 누르면 방향만 뒤집고, 다른 컬럼이면 desc 로 시작한다
                            // — 지표는 큰 값부터 보는 쪽이 대개 궁금한 것이다.
                            onClick={() =>
                              updateFilter({
                                sort: `${col.sortKey}-${active && sortDirection === "desc" ? "asc" : "desc"}`,
                              })
                            }
                            // button 은 폰트를 상속하지 않는다 — th 의 text-[10px] 을
                            // 물려받지 못해 정렬 가능한 컬럼만 커 보인다.
                            className={`inline-flex items-center gap-0.5 text-[10px] uppercase font-medium hover:text-sienna-500 transition-colors duration-150 ${col.align === "right" ? "justify-end w-full" : ""}`}
                          >
                            {col.label}
                            {/* 비활성 컬럼도 화살표를 흐리게 남긴다 — 어디를 누를 수 있는지
                                보이지 않으면 정렬 기능 자체가 발견되지 않는다. */}
                            <span className={active ? "" : "text-sand-300"}>
                              {active ? (sortDirection === "desc" ? "↓" : "↑") : "↕"}
                            </span>
                          </button>
                        ) : (
                          col.label
                        )}
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
                      <RequestModel
                        status={row.status}
                        requestedModel={row.requested_model_name}
                        servedModel={row.model_name}
                        fallbackCount={row.fallback_count}
                      />
                      {row.response_json_ok === false && (
                        <span
                          title="structured 요청의 응답이 JSON 파싱에 실패했습니다"
                          className="ml-1.5 rounded-full bg-caution-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-caution-500"
                        >
                          broken
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-1.5 text-right tabular-nums text-sand-500 whitespace-nowrap">
                      {formatTtft(row.ttft_ms)}
                    </td>
                    <td className="pl-5 pr-3 py-1.5 text-right tabular-nums text-sand-500 whitespace-nowrap">
                      {formatDuration(row.duration_ms)}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-sand-700">
                      {formatNum(row.input_tokens)}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-sand-700">
                      {formatNum(row.output_tokens)}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-sand-700">
                      {formatNum(row.cache_read_tokens)}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-sand-700">
                      {formatNum(row.cache_creation_tokens)}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-sand-700">
                      {cacheHitRate(row)}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-sand-500">
                      {row.tool_call_count > 0 ? row.tool_call_count : "—"}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-sand-700">
                      {row.image_cost_usd !== null
                        ? formatMicroUsd((row.cost_usd ?? 0) + row.image_cost_usd)
                        : row.cost_usd !== null
                          ? formatMicroUsd(row.cost_usd)
                          : "—"}
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
