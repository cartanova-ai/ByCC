import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { clsx } from "clsx";
import { useEffect, useMemo, useRef, useState } from "react";
import RefreshIcon from "~icons/lucide/refresh-cw";

import { type MonitSearch } from "@/routes/monit";
import { type MonitLogChunk, type MonitLogEntry } from "@/services/monit/monit.types";
import { MonitService } from "@/services/services.generated";

const POLL_INTERVAL_MS = 1_000;
const STALE_AFTER_MS = 5_000;
// 재시작이 누적돼도 클라이언트 메모리가 무한히 자라지 않도록 미러를 캡한다.
const MIRROR_CAP = 4_000;

type LineItem =
  | { kind: "log"; key: number; entry: MonitLogEntry }
  | { kind: "restart"; key: number; processStartedAt: number }
  | { kind: "dropped"; key: number; count: number };

const LEVEL_RANK: Record<string, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warning: 3,
  error: 4,
  fatal: 5,
};

// autoscale 관측 모드: queue 압력에 따른 worker 증설/축소 흐름만 골라 본다.
const SCALING_PATTERN = /autoscale|worker/i;

const LEVEL_LABEL: Record<string, string> = {
  trace: "TRC",
  debug: "DBG",
  info: "INF",
  warning: "WRN",
  error: "ERR",
  fatal: "FTL",
};

const TIME_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function formatTime(epochMs: number): string {
  return TIME_FORMATTER.format(new Date(epochMs));
}

function categoryLabel(category: string[]): string {
  return category.join("·");
}

export function MonitConsole({
  search,
  onSearchChange,
}: {
  search: MonitSearch;
  onSearchChange: (next: MonitSearch) => void;
}) {
  const [items, setItems] = useState<LineItem[]>([]);
  const cursorRef = useRef<number | undefined>(undefined);
  const epochRef = useRef<number | undefined>(undefined);
  const keyRef = useRef(0);
  const [clock, setClock] = useState(() => Date.now());

  const query = useQuery({
    // 안정된 queryKey — 커서를 key 에 실으면 커서가 바뀔 때마다 즉시 refetch 되어
    // 1초 간격이 붕괴한다. 커서는 ref 로만 전달한다.
    queryKey: ["Monit", "monitLogs"],
    queryFn: () => MonitService.monitLogs(cursorRef.current),
    refetchInterval: POLL_INTERVAL_MS,
    retry: false,
  });
  // 프로세스 정적 정보 — 폴링 없이 1회. 라이브 카운트는 로그 폴링에 편승해 도착한다.
  const infoQuery = useQuery({ ...MonitService.monitInfoQueryOptions(), staleTime: Infinity });
  const info = infoQuery.data;
  const vitals = query.data?.vitals;

  useEffect(() => {
    const chunk = query.data;
    if (!chunk) return;
    applyChunk(chunk);
    // eslint 없이도 의도가 분명하도록: 새 응답 객체마다 정확히 한 번 반영한다.
  }, [query.data]);

  function applyChunk(chunk: MonitLogChunk): void {
    const nextKey = () => ++keyRef.current;
    setItems((prev) => {
      let base = prev;
      const appended: LineItem[] = [];

      if (epochRef.current !== undefined && chunk.processStartedAt !== epochRef.current) {
        // 서버 재시작 — seq 공간이 리셋됐으므로 미러도 리셋한다 (AE1).
        base = [];
        appended.push({
          kind: "restart",
          key: nextKey(),
          processStartedAt: chunk.processStartedAt,
        });
      } else if (chunk.dropped > 0) {
        appended.push({ kind: "dropped", key: nextKey(), count: chunk.dropped });
      }
      epochRef.current = chunk.processStartedAt;
      cursorRef.current = chunk.nextCursor;

      const lastSeq = base.findLast(
        (item): item is LineItem & { kind: "log" } => item.kind === "log",
      )?.entry.seq;
      for (const entry of chunk.entries) {
        // 커서가 중복을 막지만, 경계 중복은 방어적으로 한 번 더 거른다 (AE4).
        if (lastSeq !== undefined && entry.seq <= lastSeq) continue;
        appended.push({ kind: "log", key: nextKey(), entry });
      }
      if (appended.length === 0) return prev;
      const next = [...base, ...appended];
      return next.length > MIRROR_CAP ? next.slice(-MIRROR_CAP) : next;
    });
  }

  // stale 판정용 저해상도 시계 — 1초 폴링이라 2초 tick 이면 충분하다.
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 2_000);
    return () => window.clearInterval(timer);
  }, []);

  const isStale =
    items.length > 0 &&
    (query.isRefetchError ||
      (query.dataUpdatedAt > 0 && clock - query.dataUpdatedAt > STALE_AFTER_MS));

  const visible = useMemo(() => {
    return items.filter((item) => {
      if (item.kind !== "log") return true;
      switch (search.level) {
        case "scaling":
          return SCALING_PATTERN.test(item.entry.text);
        case "warn":
          return (LEVEL_RANK[item.entry.level] ?? 2) >= 3;
        case "error":
          return (LEVEL_RANK[item.entry.level] ?? 2) >= 4;
        default:
          return true;
      }
    });
  }, [items, search.level]);

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 20,
    getItemKey: (index) => visible[index].key,
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: 80,
    overscan: 12,
  });
  const atEnd = virtualizer.isAtEnd();

  const hasFirstData = query.dataUpdatedAt > 0;
  const firstLoadFailed = !hasFirstData && query.isError;

  return (
    <section className="panel overflow-hidden">
      <header className="panel-header flex min-h-11 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 sm:px-5">
        <h2 className="text-[13px] font-semibold tracking-[-0.01em] text-sand-800">Server logs</h2>
        <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-sand-700">
          <span
            className={clsx(
              "size-1.5 rounded-full",
              isStale || firstLoadFailed
                ? "bg-danger-400"
                : "bg-sienna-500 motion-safe:animate-pulse",
            )}
          />
          {firstLoadFailed ? "Disconnected" : isStale ? "Stale" : hasFirstData ? "Live" : "…"}
        </span>
        {epochRef.current !== undefined && (
          <span className="text-[11px] text-sand-500">
            ephemeral · resets on restart · since {formatTime(epochRef.current)}
          </span>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="segmented-control inline-flex" role="tablist" aria-label="Log filter">
            {(
              [
                { value: "all", label: "All" },
                { value: "scaling", label: "Scaling" },
                { value: "warn", label: "Warn+" },
                { value: "error", label: "Err+" },
              ] as const
            ).map((option) => (
              <button
                key={option.value}
                type="button"
                data-active={search.level === option.value}
                onClick={() => onSearchChange({ ...search, level: option.value })}
                className="rounded-[6px] px-2.5 py-1 text-[11px] font-medium text-sand-500 transition-colors hover:text-sand-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sienna-300 data-[active=true]:text-sand-900"
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {info && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-sand-100 bg-sand-50/60 px-4 py-2 text-[11px] text-sand-600 sm:px-5">
          <span>
            server <span className="font-mono text-sand-800">{info.serverUrl}</span>
          </span>
          <span>
            db{" "}
            <span className="font-mono text-sand-800">
              {info.dbHost}/{info.dbName}
            </span>
          </span>
          <span>
            workers/token{" "}
            <span className="font-mono text-sand-800">
              {info.openai.minWorkersPerToken}–{info.openai.maxWorkersPerToken}
            </span>{" "}
            {info.openai.autoscale ? "autoscale" : "fixed"}
          </span>
          {vitals && (
            <>
              <span>
                openai workers{" "}
                <span className="font-mono text-sand-800">
                  {vitals.openaiReadyWorkerCount}/{vitals.openaiWorkerCount}
                </span>{" "}
                ready
              </span>
              <span>
                queue{" "}
                <span
                  className={clsx(
                    "font-mono",
                    vitals.openaiQueueLength > 0
                      ? "font-semibold text-caution-500"
                      : "text-sand-800",
                  )}
                >
                  {vitals.openaiQueueLength}
                </span>
              </span>
            </>
          )}
        </div>
      )}

      {vitals &&
        (vitals.openaiWorkersByToken.length > 0 || vitals.anthropicTokenNames.length > 0) && (
          <div className="space-y-1.5 border-b border-sand-100 px-4 py-2.5 sm:px-5">
            {vitals.openaiWorkersByToken.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-[4.5rem] shrink-0 text-[10px] font-medium uppercase tracking-[0.08em] text-sand-400">
                  openai
                </span>
                {vitals.openaiWorkersByToken.map((token) => (
                  <span
                    key={token.name}
                    title={`${token.name}: ${token.count} workers`}
                    className="inline-flex items-baseline gap-1.5 rounded-md border border-sand-200 bg-white px-2 py-1"
                  >
                    <span className="font-mono text-[11px] text-sand-600">
                      {token.name.split("/").pop()}
                    </span>
                    <span className="font-mono text-[13px] font-semibold tracking-[-0.02em] text-sand-900">
                      {token.count}
                    </span>
                  </span>
                ))}
              </div>
            )}
            {vitals.anthropicTokenNames.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-[4.5rem] shrink-0 text-[10px] font-medium uppercase tracking-[0.08em] text-sand-400">
                  anthropic
                </span>
                {vitals.anthropicTokenNames.map((name) => (
                  <span
                    key={name}
                    title={name}
                    className="inline-flex items-baseline rounded-md border border-sand-200 bg-white px-2 py-1 font-mono text-[11px] text-sand-600"
                  >
                    {name.split("/").pop()}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

      <div className="relative">
        <div
          ref={parentRef}
          role="log"
          aria-label="Server process logs"
          tabIndex={0}
          className="main-scroll h-[calc(100vh-232px)] min-h-[320px] overflow-y-auto bg-sand-900 px-4 py-3 font-mono text-[12px] leading-[1.6] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sienna-400"
        >
          {firstLoadFailed ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-sand-400">
              <p className="text-[12px]">
                Could not reach the qgrid server — is it running?
                {query.error instanceof Error && (
                  <span className="block text-center text-[11px] text-sand-500">
                    {query.error.message}
                  </span>
                )}
              </p>
              <button
                type="button"
                onClick={() => void query.refetch()}
                className="inline-flex items-center gap-1.5 rounded-md border border-sand-600 px-2.5 py-1.5 text-[11px] font-medium text-sand-300 transition-colors hover:bg-sand-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sienna-400"
              >
                <RefreshIcon className="size-3" />
                Retry now
              </button>
            </div>
          ) : !hasFirstData ? (
            <div className="flex h-full items-center justify-center text-[12px] text-sand-500">
              Connecting to server logs…
            </div>
          ) : visible.length === 0 ? (
            <div className="flex h-full items-center justify-center text-[12px] text-sand-500">
              {items.length === 0
                ? `No log lines yet — waiting for activity since ${
                    epochRef.current !== undefined ? formatTime(epochRef.current) : "startup"
                  }.`
                : "No lines match the current filters."}
            </div>
          ) : (
            <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const item = visible[virtualRow.index];
                return (
                  <div
                    key={virtualRow.key}
                    ref={virtualizer.measureElement}
                    data-index={virtualRow.index}
                    className="absolute left-0 top-0 w-full"
                    style={{ transform: `translateY(${virtualRow.start}px)` }}
                  >
                    <LogLine item={item} />
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {hasFirstData && !firstLoadFailed && !atEnd && (
          <button
            type="button"
            onClick={() => virtualizer.scrollToEnd()}
            className="absolute bottom-4 right-5 inline-flex items-center gap-1.5 rounded-full border border-sand-600 bg-sand-800/90 px-3 py-1.5 text-[11px] font-medium text-sand-200 shadow-lg backdrop-blur transition-colors hover:bg-sand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sienna-400"
          >
            ↓ Jump to live
          </button>
        )}
      </div>
    </section>
  );
}

function LogLine({ item }: { item: LineItem }) {
  if (item.kind === "restart") {
    return (
      <div className="py-1 text-center text-[11px] text-caution-400">
        ── process restarted · {formatTime(item.processStartedAt)} ──
      </div>
    );
  }
  if (item.kind === "dropped") {
    return (
      <div className="py-1 text-center text-[11px] italic text-sand-500">
        ── {item.count} lines dropped (buffer overflow) ──
      </div>
    );
  }

  const { entry } = item;
  return (
    <div className="whitespace-pre-wrap break-words text-sand-200">
      <span className="text-sand-500">{formatTime(entry.timestamp)}</span>{" "}
      <span
        className={clsx(
          "font-semibold",
          entry.level === "fatal" || entry.level === "error"
            ? "text-danger-400"
            : entry.level === "warning"
              ? "text-caution-400"
              : "text-sand-400",
        )}
      >
        {LEVEL_LABEL[entry.level] ?? entry.level.slice(0, 3).toUpperCase()}
      </span>{" "}
      <span className="text-sienna-300">{categoryLabel(entry.category)}</span>{" "}
      <span>{entry.text}</span>
    </div>
  );
}
