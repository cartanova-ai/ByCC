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

function barColor(pct: number): string {
  if (pct >= 95) return "bg-red-500";
  if (pct >= 80) return "bg-amber-400";
  return "bg-sienna-400";
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
}: {
  label: string;
  utilization: number | null;
  resetsAt: string | null;
}) {
  const pct = utilization ?? 0;
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-sand-600 w-20 shrink-0">{label}</span>
      <div className="flex-1 h-2 bg-sand-200 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-300 ${barColor(pct)}`}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
      <span className="text-xs tabular-nums text-sand-700 w-10 text-right">{pct}%</span>
      <span className="text-[10px] text-sand-400 w-24 text-right">{formatResets(resetsAt)}</span>
    </div>
  );
}

function TokenUsage({ token }: { token: Token }) {
  const { data, isLoading } = QgridService.useUsage(token.name);
  if (isLoading) {
    return (
      <div className="animate-pulse space-y-2 py-2">
        <div className="h-2 w-full bg-sand-200 rounded-full" />
        <div className="h-2 w-3/4 bg-sand-200 rounded-full" />
      </div>
    );
  }

  if (data?.error) {
    return (
      <div className="py-1">
        <p className="text-[11px] text-amber-600">Session expired</p>
        <p className="text-[10px] text-sand-400 mt-0.5">
          Please re-login via OAuth or update your token
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
        />
      )}
      {data.sevenDay && (
        <UsageRow
          label="7d"
          utilization={data.sevenDay.utilization}
          resetsAt={data.sevenDay.resetsAt}
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
      className="relative rounded-lg bg-sand-50 px-4 py-3 select-none cursor-grab active:cursor-grabbing touch-none"
    >
      <div className="flex items-center gap-2 mb-2">
        <GripVerticalIcon className="size-3.5 text-sand-300 shrink-0" />
        <span className="text-sm font-medium text-sand-800 truncate">
          {token.name ?? "Unnamed"}
        </span>
        <span className="text-[10px] px-1.5 py-0.5 rounded-full shrink-0 bg-sand-200 text-sand-500 uppercase">
          {token.provider}
        </span>
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded-full shrink-0 ${token.active ? "bg-sage-100 text-sage-600" : "bg-sand-200 text-sand-500"}`}
        >
          {token.active ? "Active" : "Inactive"}
        </span>
      </div>
      <TokenUsage token={token} />
      <span className="absolute top-2 right-3 px-2 py-0.5 rounded-md bg-white text-[11px] tabular-nums font-medium text-sienna-600 border border-sand-200">
        {formatUsd(costData?.usd ?? 0)}
      </span>
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
      <div className="grid grid-cols-2 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={`skel-${i}`} className="rounded-lg bg-sand-50 px-4 py-3 animate-pulse">
            <div className="h-3 w-16 bg-sand-200 rounded mb-3" />
            <div className="h-2 w-full bg-sand-200 rounded-full" />
          </div>
        ))}
      </div>
    );
  }

  if (localTokens.length === 0) {
    return (
      <div className="rounded-lg bg-sand-50 px-5 py-4">
        <p className="text-sand-400 text-sm">No tokens registered</p>
      </div>
    );
  }

  const filteredTokens =
    providerFilter === "all"
      ? localTokens
      : localTokens.filter((t) => t.provider === providerFilter);

  return (
    <div className="space-y-3">
      <div className="flex gap-1">
        {PROVIDERS.map((p) => (
          <button
            key={p}
            type="button"
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors duration-150 ${
              providerFilter === p
                ? "bg-sand-900 text-white"
                : "bg-sand-100 text-sand-600 hover:bg-sand-200"
            }`}
            onClick={() => setProviderFilter(p)}
          >
            {p === "all" ? "All" : p === "openai" ? "OpenAI" : "Anthropic"}
          </button>
        ))}
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={filteredTokens.map((t) => String(t.id))} strategy={rectSortingStrategy}>
          <div className="grid grid-cols-2 gap-3">
            {filteredTokens.map((token) => (
              <SortableTokenCard key={token.id} token={token} />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}
