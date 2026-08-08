import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { SettingService } from "@/services/services.generated";
import { type SettingItem } from "@/services/setting/setting.types";

/** 저장 후 안내. 워커 설정은 dispatcher 생성자에서만 읽혀 재시작해야 반영된다. */
function AppliesBadge({ applies }: { applies: SettingItem["applies"] }) {
  if (applies === "immediate") {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-sage-100 text-sage-600">
        즉시 적용
      </span>
    );
  }
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-caution-400/15 text-caution-500">
      재시작 후 적용
    </span>
  );
}

function SettingRow({ item }: { item: SettingItem }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const updateMutation = SettingService.useUpdateSettingMutation();
  const resetMutation = SettingService.useResetSettingMutation();

  const editing = draft !== null;
  const pending = updateMutation.isPending || resetMutation.isPending;

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["Setting", "getSettingList"] });

  const save = async () => {
    if (draft === null) return;
    setError(null);
    try {
      await updateMutation.mutateAsync({ key: item.key, value: draft });
      await invalidate();
      setDraft(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const reset = async () => {
    setError(null);
    try {
      await resetMutation.mutateAsync({ key: item.key });
      await invalidate();
      setDraft(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-medium text-sand-800">{item.label}</span>
        <AppliesBadge applies={item.applies} />
        {/* env 를 쓰는 중인지 저장된 값인지 보이지 않으면 "왜 안 바뀌지"가 된다. */}
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded-full ${
            item.stored ? "bg-sienna-50 text-sienna-600" : "bg-sand-100 text-sand-500"
          }`}
        >
          {item.stored ? "저장됨" : "env"}
        </span>
        <span className="ml-auto text-[10px] font-mono text-sand-400">{item.key}</span>
      </div>

      {item.help && <p className="mt-1 text-[11px] text-sand-500">{item.help}</p>}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {item.kind === "boolean" ? (
          <select
            value={editing ? draft : item.value || "true"}
            onChange={(e) => setDraft(e.target.value)}
            disabled={pending}
            className="border border-sand-200/80 rounded-lg px-2.5 py-1.5 text-[12px] text-sand-700 bg-white focus:outline-none focus:border-sienna-300"
          >
            <option value="true">켜짐</option>
            <option value="false">꺼짐</option>
          </select>
        ) : (
          <input
            value={editing ? draft : item.value}
            onChange={(e) => setDraft(e.target.value)}
            disabled={pending}
            inputMode={item.kind === "integer" || item.kind === "number" ? "numeric" : undefined}
            placeholder={item.kind === "secret" ? "새 값을 입력하면 교체됩니다" : undefined}
            className="flex-1 min-w-0 border border-sand-200/80 rounded-lg px-2.5 py-1.5 text-[12px] text-sand-700 bg-white tabular-nums focus:outline-none focus:border-sienna-300"
          />
        )}

        {editing && (
          <button
            type="button"
            onClick={() => void save()}
            disabled={pending}
            className="px-2.5 py-1.5 text-[11px] font-medium rounded-lg bg-sienna-400 text-white hover:bg-sienna-500 disabled:opacity-50 transition-colors duration-150"
          >
            {updateMutation.isPending ? "저장 중..." : "저장"}
          </button>
        )}
        {editing && (
          <button
            type="button"
            onClick={() => {
              setDraft(null);
              setError(null);
            }}
            disabled={pending}
            className="px-2.5 py-1.5 text-[11px] rounded-lg border border-sand-200 text-sand-600 hover:bg-sand-100 disabled:opacity-50 transition-colors duration-150"
          >
            취소
          </button>
        )}
        {!editing && item.stored && (
          <button
            type="button"
            title="저장된 값을 지우고 env 기본값으로 되돌립니다"
            onClick={() => void reset()}
            disabled={pending}
            className="px-2.5 py-1.5 text-[11px] rounded-lg border border-sand-200 text-sand-500 hover:bg-sand-100 disabled:opacity-50 transition-colors duration-150"
          >
            {resetMutation.isPending ? "되돌리는 중..." : "env 로 되돌리기"}
          </button>
        )}
      </div>

      {error && <p className="mt-1.5 text-[11px] text-red-500">{error}</p>}
    </div>
  );
}

export function SettingsPanel() {
  const { data, isLoading } = SettingService.useSettingList();

  if (isLoading) {
    return (
      <div className="panel px-5 py-10">
        <p className="text-sand-400 text-[13px] text-center">로딩 중...</p>
      </div>
    );
  }

  const settings = data?.settings ?? [];
  const runtime = data?.runtime ?? [];

  return (
    <div className="space-y-4">
      <div className="panel overflow-hidden">
        <div className="panel-header px-4 py-2.5 sm:px-5">
          <span className="text-[13px] font-medium text-sand-700">런타임 설정</span>
        </div>
        <div className="divide-y divide-sand-100/80">
          {settings.map((item) => (
            <SettingRow key={item.key} item={item} />
          ))}
        </div>
      </div>

      <div className="panel overflow-hidden">
        <div className="panel-header px-4 py-2.5 sm:px-5">
          <span className="text-[13px] font-medium text-sand-700">환경 정보</span>
          <span className="ml-2 text-[11px] text-sand-400">기동 시점 값 — 변경 불가</span>
        </div>
        <div className="px-4 py-3 sm:px-5 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
          {runtime.map((info) => (
            <div key={info.label} className="flex items-center justify-between gap-3 min-w-0">
              <span className="text-[11px] text-sand-500 shrink-0">{info.label}</span>
              <span className="text-[12px] text-sand-700 font-mono truncate">{info.value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
