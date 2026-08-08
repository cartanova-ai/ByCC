import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import EyeIcon from "~icons/lucide/eye";
import EyeOffIcon from "~icons/lucide/eye-off";
import MinusIcon from "~icons/lucide/minus";
import PlusIcon from "~icons/lucide/plus";
import RotateIcon from "~icons/lucide/rotate-ccw";

import { SettingService } from "@/services/services.generated";
import { type SettingItem } from "@/services/setting/setting.types";

const GROUP_LABELS: Record<string, string> = {
  openai: "OpenAI 워커",
  slack: "Slack 알림",
};

function maskValue(value: string): string {
  if (!value) return "";
  if (value.length <= 12) return "•".repeat(value.length);
  return `${value.slice(0, 8)}${"•".repeat(12)}${value.slice(-4)}`;
}

/** 정수·실수는 타이핑보다 증감이 빠르다. 범위도 버튼이 알아서 지킨다. */
function Stepper({
  value,
  min,
  max,
  step,
  disabled,
  onChange,
}: {
  value: string;
  min: number | null;
  max: number | null;
  step: number;
  disabled: boolean;
  onChange: (next: string) => void;
}) {
  const current = Number(value);
  const valid = Number.isFinite(current);
  const lower = min ?? Number.NEGATIVE_INFINITY;
  const upper = max ?? Number.POSITIVE_INFINITY;

  const adjust = (delta: number) => {
    const base = valid ? current : (min ?? 0);
    const next = Math.min(Math.max(base + delta, lower), upper);
    // 0.5 단위 실수에서 부동소수 잔재가 남지 않게 자른다.
    onChange(String(Number(next.toFixed(2))));
  };

  return (
    <div className="inline-flex items-center rounded-lg border border-sand-200/80 bg-white overflow-hidden">
      <button
        type="button"
        aria-label="감소"
        onClick={() => adjust(-step)}
        disabled={disabled || (valid && current <= lower)}
        className="size-7 grid place-items-center text-sand-500 hover:bg-sand-100 disabled:opacity-30 disabled:hover:bg-transparent transition-colors duration-150"
      >
        <MinusIcon className="size-3" />
      </button>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        inputMode="decimal"
        className="w-12 text-center text-[12px] tabular-nums text-sand-800 bg-transparent border-x border-sand-200/80 py-1 focus:outline-none focus:bg-sand-50"
      />
      <button
        type="button"
        aria-label="증가"
        onClick={() => adjust(step)}
        disabled={disabled || (valid && current >= upper)}
        className="size-7 grid place-items-center text-sand-500 hover:bg-sand-100 disabled:opacity-30 disabled:hover:bg-transparent transition-colors duration-150"
      >
        <PlusIcon className="size-3" />
      </button>
    </div>
  );
}

function Toggle({
  on,
  disabled,
  onChange,
}: {
  on: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-200 disabled:opacity-50 ${
        on ? "bg-sage-400" : "bg-sand-300"
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform duration-200 ${
          on ? "translate-x-4.5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

function SettingRow({ item }: { item: SettingItem }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const updateMutation = SettingService.useUpdateSettingMutation();
  const resetMutation = SettingService.useResetSettingMutation();

  const pending = updateMutation.isPending || resetMutation.isPending;
  const value = draft ?? item.value;
  const dirty = draft !== null && draft !== item.value;

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["Setting", "getSettingList"] });

  const commit = async (next: string) => {
    setError(null);
    try {
      await updateMutation.mutateAsync({ key: item.key, value: next });
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

  // boolean 은 누르는 즉시 확정한다 — 토글에 저장 버튼을 붙이면 조작이 두 단계가 된다.
  const isToggle = item.kind === "boolean";
  const isNumeric = item.kind === "integer" || item.kind === "number";
  const isSecret = item.kind === "secret";

  return (
    <div className="px-4 py-3 sm:px-5">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13px] text-sand-800">{item.label}</span>
            {item.applies === "restart" && (
              <span
                className="text-[10px] text-caution-500"
                title="저장해도 다음 재시작부터 반영됩니다"
              >
                재시작 필요
              </span>
            )}
          </div>
          {item.help && <p className="mt-0.5 text-[11px] text-sand-500">{item.help}</p>}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {isToggle && (
            <Toggle
              on={value === "true"}
              disabled={pending}
              onChange={(next) => void commit(String(next))}
            />
          )}

          {isNumeric && (
            <Stepper
              value={value}
              min={item.min}
              max={item.max}
              step={item.kind === "integer" ? 1 : 0.5}
              disabled={pending}
              onChange={setDraft}
            />
          )}

          {(item.kind === "string" || isSecret) && (
            <div className="relative">
              <input
                value={isSecret && !revealed ? maskValue(value) : value}
                onChange={(e) => setDraft(e.target.value)}
                onFocus={() => isSecret && setRevealed(true)}
                disabled={pending}
                className={`w-48 sm:w-64 rounded-lg border border-sand-200/80 bg-white py-1.5 pl-2.5 text-[12px] text-sand-800 focus:outline-none focus:border-sienna-300 ${
                  isSecret ? "pr-8 font-mono" : "pr-2.5"
                }`}
              />
              {isSecret && (
                <button
                  type="button"
                  aria-label={revealed ? "값 숨기기" : "값 보기"}
                  onClick={() => setRevealed((r) => !r)}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 size-6 grid place-items-center text-sand-400 hover:text-sand-600 transition-colors duration-150"
                >
                  {revealed ? (
                    <EyeOffIcon className="size-3.5" />
                  ) : (
                    <EyeIcon className="size-3.5" />
                  )}
                </button>
              )}
            </div>
          )}

          {dirty && (
            <button
              type="button"
              onClick={() => void commit(value)}
              disabled={pending}
              className="px-2.5 py-1.5 text-[11px] font-medium rounded-lg bg-sienna-400 text-white hover:bg-sienna-500 disabled:opacity-50 transition-colors duration-150"
            >
              {updateMutation.isPending ? "저장 중" : "저장"}
            </button>
          )}

          {/* 저장값이 있을 때만 되돌릴 대상이 있다. */}
          {!dirty && item.source === "db" && (
            <button
              type="button"
              title="저장값을 지우고 env 또는 기본값으로 되돌립니다"
              onClick={() => void reset()}
              disabled={pending}
              className="size-7 grid place-items-center rounded-lg text-sand-400 hover:text-sand-600 hover:bg-sand-100 disabled:opacity-50 transition-colors duration-150"
            >
              <RotateIcon className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {error && <p className="mt-1.5 text-[11px] text-red-500">{error}</p>}
    </div>
  );
}

function SourceLegend({ items }: { items: SettingItem[] }) {
  const stored = items.filter((i) => i.source === "db").length;
  if (stored === 0) return null;
  return <span className="text-[11px] text-sand-400">{stored}개 항목이 저장값을 사용 중</span>;
}

export function SettingsPanel() {
  const { data, isLoading } = SettingService.useSettingList();

  if (isLoading) {
    return (
      <div className="space-y-4">
        {[0, 1].map((i) => (
          <div key={i} className="panel overflow-hidden">
            <div className="panel-header px-4 py-2.5 sm:px-5">
              <div className="h-3 w-24 rounded bg-sand-200 animate-pulse" />
            </div>
            <div className="divide-y divide-sand-100/80">
              {[0, 1, 2].map((j) => (
                <div key={j} className="px-4 py-3 sm:px-5 flex items-center justify-between gap-4">
                  <div className="h-3 w-40 rounded bg-sand-100 animate-pulse" />
                  <div className="h-7 w-24 rounded-lg bg-sand-100 animate-pulse" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  const settings = data?.settings ?? [];
  const runtime = data?.runtime ?? [];
  const groups = [...new Set(settings.map((s) => s.group))];

  return (
    <div className="space-y-4">
      <div className="panel overflow-hidden">
        <div className="panel-header flex items-center justify-between px-4 py-2.5 sm:px-5">
          <span className="text-[13px] font-medium text-sand-700">환경</span>
          <span className="text-[11px] text-sand-400">기동 시점 값</span>
        </div>
        <dl className="px-4 py-3 sm:px-5 grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-1.5">
          {runtime.map((info) => (
            <div key={info.label} className="flex items-baseline justify-between gap-3 min-w-0">
              <dt className="text-[11px] text-sand-500 shrink-0">{info.label}</dt>
              <dd className="text-[12px] font-mono text-sand-700 truncate">{info.value}</dd>
            </div>
          ))}
        </dl>
      </div>

      {groups.map((group) => {
        const items = settings.filter((s) => s.group === group);
        return (
          <div key={group} className="panel overflow-hidden">
            <div className="panel-header flex items-center justify-between px-4 py-2.5 sm:px-5">
              <span className="text-[13px] font-medium text-sand-700">
                {GROUP_LABELS[group] ?? group}
              </span>
              <SourceLegend items={items} />
            </div>
            <div className="divide-y divide-sand-100/80">
              {items.map((item) => (
                <SettingRow key={item.key} item={item} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
