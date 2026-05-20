import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, rectSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import GripVerticalIcon from "~icons/lucide/grip-vertical";

import { formatUsd } from "@/lib/cost";
import { QgridService, TokenService } from "@/services/services.generated";
import { type TokenSubsetMapping } from "@/services/sonamu.generated";

type Token = TokenSubsetMapping["A"];

type ProviderTheme = {
  stripe: string;
  bar: string;
  badge: string;
  cost: string;
};

const PROVIDER_THEMES: Record<string, ProviderTheme> = {
  openai: {
    stripe: "bg-openai-400",
    bar: "bg-openai-bar",
    badge: "bg-openai-50 text-openai-600",
    cost: "text-openai-600",
  },
  anthropic: {
    stripe: "bg-anthropic-400",
    bar: "bg-anthropic-400",
    badge: "bg-anthropic-50 text-anthropic-600",
    cost: "text-anthropic-600",
  },
  google: {
    stripe: "bg-google-400",
    bar: "bg-google-400",
    badge: "bg-google-50 text-google-600",
    cost: "text-google-600",
  },
};

const DEFAULT_THEME: ProviderTheme = {
  stripe: "bg-sand-400",
  bar: "bg-sienna-400",
  badge: "bg-sand-200 text-sand-500",
  cost: "text-sienna-600",
};

function getProviderTheme(provider: string): ProviderTheme {
  return PROVIDER_THEMES[provider] ?? DEFAULT_THEME;
}

function barColor(pct: number, theme: ProviderTheme): string {
  if (pct >= 95) return "bg-danger-400";
  if (pct >= 80) return "bg-caution-400";
  return theme.bar;
}

function formatResets(iso: string | null): string {
  if (!iso) return "";
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "resetting...";
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  return h > 0 ? `resets ${h}h ${m}m` : `resets ${m}m`;
}

function UsageRow({
  label,
  utilization,
  resetsAt,
  theme,
}: {
  label: string;
  utilization: number | null;
  resetsAt: string | null;
  theme: ProviderTheme;
}) {
  const pct = utilization ?? 0;
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-sand-600 w-20 shrink-0">{label}</span>
      <div className="flex-1 h-2 bg-sand-200 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-300 ${barColor(pct, theme)}`}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
      <span className="text-xs tabular-nums text-sand-700 w-10 text-right">{pct}%</span>
      <span className="text-[10px] text-sand-400 w-24 text-right">{formatResets(resetsAt)}</span>
    </div>
  );
}

function TokenUsage({ token, theme }: { token: Token; theme: ProviderTheme }) {
  const { data, isLoading } = QgridService.useUsage(token.id);
  if (isLoading) {
    return (
      <div className="animate-pulse space-y-2 py-2">
        <div className="h-2 w-full bg-sand-200 rounded-full" />
        <div className="h-2 w-3/4 bg-sand-200 rounded-full" />
      </div>
    );
  }

  if (data?.error) {
    const isExpired =
      data.error.includes("re-login") ||
      data.error.includes("token_revoked") ||
      data.error.includes("401");
    return (
      <div className="py-1">
        <p className="text-[11px] text-amber-600">
          {isExpired ? "Session expired" : "Unavailable"}
        </p>
        <p className="text-[10px] text-sand-400 mt-0.5">
          {isExpired ? "Please re-login via OAuth" : data.error}
        </p>
      </div>
    );
  }

  if (!data?.fiveHour && !data?.sevenDay) {
    return <p className="text-[11px] text-sand-400 py-1">No usage data</p>;
  }

  return (
    <div className="space-y-1.5 py-1">
      {data.fiveHour && (
        <UsageRow
          label="5h"
          utilization={data.fiveHour.utilization}
          resetsAt={data.fiveHour.resetsAt}
          theme={theme}
        />
      )}
      {data.sevenDay && (
        <UsageRow
          label="7d"
          utilization={data.sevenDay.utilization}
          resetsAt={data.sevenDay.resetsAt}
          theme={theme}
        />
      )}
    </div>
  );
}

function SortableTokenCard({ token }: { token: Token }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: String(token.id),
    transition: {
      duration: 200,
      easing: "ease",
    },
  });
  const { data: costData } = QgridService.useTotalCost(token.name, {
    enabled: !!token.name,
  });
  const theme = getProviderTheme(token.provider);

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className="relative rounded-lg bg-white border border-sand-200/80 overflow-hidden select-none cursor-grab active:cursor-grabbing touch-none shadow-sm hover:shadow-md transition-shadow duration-200"
    >
      <div className={`absolute inset-y-0 left-0 w-1 ${theme.stripe}`} />
      <div className="pl-4 pr-4 py-3">
        <div className="flex items-center gap-2 mb-2">
          <GripVerticalIcon className="size-3.5 text-sand-300 shrink-0" />
          <span className="text-[13px] font-medium text-sand-800 truncate">
            {token.name ?? "Unnamed"}
          </span>
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded-full shrink-0 uppercase ${theme.badge}`}
          >
            {token.provider}
          </span>
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded-full shrink-0 ${token.active ? "bg-sage-100 text-sage-600" : "bg-sand-200 text-sand-500"}`}
          >
            {token.active ? "Active" : "Inactive"}
          </span>
        </div>
        <TokenUsage token={token} theme={theme} />
        <span
          className={`absolute top-2.5 right-3 px-2 py-0.5 rounded-md bg-sand-50 text-[11px] tabular-nums font-medium border border-sand-200/80 ${theme.cost}`}
        >
          {formatUsd(costData?.usd ?? 0)}
        </span>
      </div>
    </div>
  );
}

const PROVIDERS = ["all", "openai", "anthropic"] as const;
type ProviderFilter = (typeof PROVIDERS)[number];

export function UsageCard() {
  const { data, isLoading } = TokenService.useTokens("A", { orderBy: "ord-asc" });
  const queryClient = useQueryClient();
  const reorderMutation = TokenService.useReorderMutation();

  const [localTokens, setLocalTokens] = useState<Token[]>([]);
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>("all");

  useEffect(() => {
    if (data?.rows) setLocalTokens(data.rows);
  }, [data?.rows]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const activeId = Number(active.id);
    const overId = Number(over.id);
    const oldIndex = localTokens.findIndex((t) => t.id === activeId);
    const newIndex = localTokens.findIndex((t) => t.id === overId);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = arrayMove(localTokens, oldIndex, newIndex);
    setLocalTokens(reordered);

    const queryKey = TokenService.getTokensQueryOptions("A", {
      orderBy: "ord-asc" as const,
    }).queryKey;
    const prev = queryClient.getQueryData(queryKey);

    queryClient.setQueryData(queryKey, (old: typeof prev) =>
      old ? { ...old, rows: reordered } : old,
    );

    reorderMutation.mutate(
      { ids: reordered.map((t) => t.id) },
      {
        onError: () => {
          queryClient.setQueryData(queryKey, prev);
          if (data?.rows) setLocalTokens(data.rows);
        },
        onSettled: () => {
          Promise.all([
            queryClient.invalidateQueries({ queryKey: ["Token"] }),
            queryClient.invalidateQueries({ queryKey: ["Qgrid"] }),
          ]);
        },
      },
    );
  };

  if (isLoading) {
    return (
      <div className="panel p-5">
        <div className="grid grid-cols-2 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={`skel-${i}`} className="rounded-lg bg-sand-50 px-4 py-3 animate-pulse">
              <div className="h-3 w-16 bg-sand-200 rounded mb-3" />
              <div className="h-2 w-full bg-sand-200 rounded-full" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (localTokens.length === 0) {
    return (
      <div className="panel px-5 py-10">
        <p className="text-sand-400 text-[13px] text-center">No tokens registered</p>
      </div>
    );
  }

  const filteredTokens =
    providerFilter === "all"
      ? localTokens
      : localTokens.filter((t) => t.provider === providerFilter);

  return (
    <div className="panel overflow-hidden">
      <div className="panel-header flex items-center justify-between px-5 py-2.5">
        <span className="text-[13px] font-medium text-sand-700">Token Usage</span>
        <div className="segmented-control flex gap-0.5">
          {PROVIDERS.map((p) => (
            <button
              key={p}
              type="button"
              data-active={providerFilter === p}
              className={`px-2.5 py-[3px] text-[11px] font-medium rounded-[6px] transition-all duration-150 ${
                providerFilter === p ? "text-sand-800" : "text-sand-500 hover:text-sand-700"
              }`}
              onClick={() => setProviderFilter(p)}
            >
              {p === "all" ? "All" : p === "openai" ? "OpenAI" : "Anthropic"}
            </button>
          ))}
        </div>
      </div>

      <div className="p-4">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext
            items={filteredTokens.map((t) => String(t.id))}
            strategy={rectSortingStrategy}
          >
            <div className="grid grid-cols-2 gap-3">
              {filteredTokens.map((token) => (
                <SortableTokenCard key={token.id} token={token} />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </div>
    </div>
  );
}
