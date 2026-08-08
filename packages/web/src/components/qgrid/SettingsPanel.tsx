import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { useEffect, useRef, useState } from "react";
import EyeIcon from "~icons/lucide/eye";
import EyeOffIcon from "~icons/lucide/eye-off";
import MinusIcon from "~icons/lucide/minus";
import PlusIcon from "~icons/lucide/plus";
import RotateIcon from "~icons/lucide/rotate-ccw";

import { QgridService, SettingService } from "@/services/services.generated";
import { type SettingItem, type SupervisorKind } from "@/services/setting/setting.types";
import { isSonamuError } from "@/services/sonamu.shared";

const GROUP_LABELS: Record<string, string> = {
  openai: "OpenAI 워커",
  slack: "Slack 알림",
  slackConnection: "Slack 연결",
};
const RESTART_READY_TIMEOUT_MS = 3 * 60 * 1_000;

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

/** 고정 선택지. 자유 입력보다 고르는 편이 빠르고, 범위를 벗어난 값이 생기지 않는다. */
function PresetGroup({
  value,
  presets,
  disabled,
  onChange,
}: {
  value: string;
  presets: number[];
  disabled: boolean;
  onChange: (next: string) => void;
}) {
  const current = Number(value);
  return (
    <div className="segmented-control inline-flex">
      {presets.map((preset) => (
        <button
          key={preset}
          type="button"
          disabled={disabled}
          data-active={current === preset}
          onClick={() => onChange(String(preset))}
          className="rounded-[6px] px-2.5 py-1 text-[11px] font-medium tabular-nums text-sand-500 transition-colors hover:text-sand-800 disabled:opacity-50 data-[active=true]:text-sand-900"
        >
          {preset >= 60 ? `${preset / 60}시간` : `${preset}분`}
        </button>
      ))}
    </div>
  );
}

/** 값이 어디서 왔는지. 되돌림 버튼이 무엇을 지우는지 이 배지가 설명한다. */
function SourceBadge({ source }: { source: SettingItem["source"] }) {
  const label = source === "db" ? "저장값" : source === "env" ? "환경변수" : "기본값";
  return (
    <span
      className={`text-[10px] px-1.5 py-0.5 rounded ${
        source === "db" ? "bg-sienna-50 text-sienna-600" : "bg-sand-100 text-sand-500"
      }`}
    >
      {label}
    </span>
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
    queryClient.invalidateQueries({
      queryKey: SettingService.getSettingListQueryOptions().queryKey,
    });

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

  const isSecret = item.kind === "secret";

  return (
    <div className="px-4 py-3 sm:px-5">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13px] text-sand-800">{item.label}</span>
            <SourceBadge source={item.source} />
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
          {/* boolean 은 누르는 즉시 확정한다 — 토글에 저장 버튼을 붙이면 조작이 두 단계가 된다. */}
          {item.kind === "boolean" && (
            <Toggle
              on={value === "true"}
              disabled={pending}
              onChange={(next) => void commit(String(next))}
            />
          )}

          {item.kind === "preset" && (
            <PresetGroup
              value={value}
              presets={item.presets}
              disabled={pending}
              onChange={(next) => void commit(next)}
            />
          )}

          {(item.kind === "integer" || item.kind === "number") && (
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
              title="저장값을 지웁니다 — 환경변수 또는 기본값으로 돌아갑니다"
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

/** 만료 알림을 주기를 기다리지 않고 지금 보낸다. 설정이 제대로 붙었는지 확인하는 용도. */
function TriggerReminderButton() {
  const [result, setResult] = useState<string | null>(null);
  const mutation = SettingService.useTriggerExpiryReminderMutation();

  const trigger = async () => {
    setResult(null);
    try {
      const { sent } = await mutation.mutateAsync();
      // 0건과 실패를 구분해준다 — 아무 반응이 없으면 버튼이 고장 난 것으로 읽힌다.
      setResult(sent === 0 ? "재로그인이 필요한 토큰이 없습니다" : `${sent}건 발송`);
    } catch (e) {
      setResult((e as Error).message);
    }
  };

  return (
    <div className="flex items-center gap-2">
      {result && <span className="text-[11px] text-sand-500">{result}</span>}
      <button
        type="button"
        onClick={() => void trigger()}
        disabled={mutation.isPending}
        className="px-2 py-1 text-[11px] rounded-lg border border-sand-200/80 text-sand-600 hover:bg-sand-100 disabled:opacity-50 transition-colors duration-150"
      >
        {mutation.isPending ? "보내는 중" : "지금 보내기"}
      </button>
    </div>
  );
}

/**
 * 재시작은 스스로 종료하고 감독자(pm2)가 다시 띄우는 것에 맡긴다. 되돌릴 수 없고 1~2분간
 * 요청이 실패하므로 확인 단계를 둔다 — 무엇이 일어나는지 모달이 먼저 설명한다.
 */
function RestartPanel({ supervisor }: { supervisor: SupervisorKind | null }) {
  const [confirming, setConfirming] = useState(false);
  const [restartRequested, setRestartRequested] = useState(false);
  const [restartStartedAt, setRestartStartedAt] = useState<number | null>(null);
  const [sawUnavailable, setSawUnavailable] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const completingRef = useRef(false);
  const restartAttemptRef = useRef(0);
  const queryClient = useQueryClient();
  const mutation = SettingService.useRestartServerMutation();
  const resetMutation = mutation.reset;
  const healthQuery = useQuery({
    ...QgridService.healthQueryOptions(),
    enabled: restartRequested && !completing,
    refetchInterval: restartRequested && !completing ? 1_000 : false,
    refetchIntervalInBackground: true,
    retry: false,
  });

  useEffect(() => {
    if (!restartRequested || restartStartedAt === null || completing) return;

    const remaining = Math.max(0, RESTART_READY_TIMEOUT_MS - (Date.now() - restartStartedAt));
    const timeout = window.setTimeout(() => {
      restartAttemptRef.current += 1;
      resetMutation();
      setConfirming(false);
      setRestartRequested(false);
      setRestartStartedAt(null);
      setSawUnavailable(false);
      setError(
        "재시작 후 3분 안에 서버 준비를 확인하지 못했습니다. 상태를 확인한 뒤 다시 시도하세요.",
      );
    }, remaining);
    return () => window.clearTimeout(timeout);
  }, [completing, resetMutation, restartRequested, restartStartedAt]);

  useEffect(() => {
    if (!restartRequested || restartStartedAt === null) return;

    const currentAttemptError =
      healthQuery.isError && healthQuery.errorUpdatedAt >= restartStartedAt;
    const currentAttemptData =
      healthQuery.isSuccess && healthQuery.dataUpdatedAt >= restartStartedAt;

    if (currentAttemptError || (currentAttemptData && healthQuery.data.ready === false)) {
      setSawUnavailable(true);
      return;
    }

    // 재시작 POST 직후 예전 프로세스의 ready:true를 받을 수 있다. 한 번이라도
    // unreachable/ready:false를 본 뒤에 돌아온 ready:true만 새 프로세스로 인정한다.
    if (
      !sawUnavailable ||
      !currentAttemptData ||
      healthQuery.data.ready !== true ||
      completingRef.current
    ) {
      return;
    }

    completingRef.current = true;
    setCompleting(true);
    void queryClient
      .invalidateQueries({
        queryKey: SettingService.getSettingListQueryOptions().queryKey,
      })
      .then(() => {
        restartAttemptRef.current += 1;
        resetMutation();
        setConfirming(false);
        setRestartRequested(false);
        setRestartStartedAt(null);
        setSawUnavailable(false);
      })
      .catch((cause) => {
        restartAttemptRef.current += 1;
        resetMutation();
        setConfirming(false);
        setRestartRequested(false);
        setRestartStartedAt(null);
        setSawUnavailable(false);
        setError(`서버는 준비됐지만 설정을 새로고침하지 못했습니다: ${(cause as Error).message}`);
      })
      .finally(() => {
        completingRef.current = false;
        setCompleting(false);
      });
  }, [
    healthQuery.dataUpdatedAt,
    healthQuery.data?.ready,
    healthQuery.errorUpdatedAt,
    healthQuery.isError,
    healthQuery.isSuccess,
    queryClient,
    resetMutation,
    restartStartedAt,
    restartRequested,
    sawUnavailable,
  ]);

  const restart = async () => {
    const attempt = restartAttemptRef.current + 1;
    restartAttemptRef.current = attempt;
    setError(null);
    setSawUnavailable(false);
    setCompleting(false);
    completingRef.current = false;
    setRestartRequested(true);
    setRestartStartedAt(Date.now());
    try {
      await mutation.mutateAsync();
    } catch (e) {
      if (restartAttemptRef.current !== attempt) return;
      // HTTP 응답으로 명확히 거부된 경우만 재시도 가능 상태로 되돌린다.
      // 응답 없는 transport 오류와 프록시 5xx는 서버가 종료되며 생긴 정상 경계일 수 있다.
      const explicitlyRejected = isSonamuError(e)
        ? e.code >= 400 && e.code < 500
        : isAxiosError(e) &&
          e.response !== undefined &&
          e.response.status >= 400 &&
          e.response.status < 500;
      if (explicitlyRejected) {
        restartAttemptRef.current += 1;
        resetMutation();
        setConfirming(false);
        setRestartRequested(false);
        setRestartStartedAt(null);
        setError((e as Error).message || "재시작 요청이 거부되었습니다.");
      }
    }
  };

  const closeConfirmation = () => {
    if (restartRequested) return;
    setConfirming(false);
    setError(null);
  };

  return (
    <div className="panel overflow-hidden">
      <div className="panel-header px-4 py-2.5 sm:px-5">
        <span className="text-[13px] font-medium text-sand-700">서버 제어</span>
      </div>
      <div className="px-4 py-3 sm:px-5 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[13px] text-sand-800">qgrid 재시작</p>
          <p className="mt-0.5 text-[11px] text-sand-500">
            {supervisor
              ? "재시작 필요 설정을 반영하고 qgrid·Codex·Claude CLI를 확인합니다"
              : "로컬 실행 환경에서는 재시작할 수 없습니다"}
          </p>
        </div>
        <button
          type="button"
          disabled={!supervisor || restartRequested || mutation.isPending}
          onClick={() => setConfirming(true)}
          className="shrink-0 px-2.5 py-1.5 text-[11px] font-medium rounded-lg border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-40 disabled:hover:bg-transparent transition-colors duration-150"
        >
          재시작
        </button>
      </div>

      {error && <p className="px-4 pb-3 sm:px-5 text-[11px] text-red-500">{error}</p>}

      {confirming && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]">
          <div
            className="absolute inset-0 bg-sand-900/8 backdrop-blur-sm"
            onClick={closeConfirmation}
            onKeyDown={() => {}}
          />
          <div className="relative panel shadow-xl w-full max-w-sm mx-4">
            <div className="px-5 py-4 border-b border-sand-100/60">
              <h3 className="text-base font-medium text-sand-900">
                {restartRequested
                  ? mutation.isPending
                    ? "재시작 요청 중"
                    : "서버 재연결 중"
                  : "qgrid 재시작"}
              </h3>
            </div>
            <div className="px-5 py-4 space-y-2">
              <p className="text-[13px] text-sand-700">
                워커가 다시 뜰 때까지 <strong className="text-sand-900">1~2분간 요청이 실패</strong>
                합니다.
              </p>
              <p className="text-[12px] text-sand-500">
                서버를 종료하면 모니터링 도구가 다시 띄웁니다. 이때 재시작 필요 설정을 반영하고,
                qgrid와 Codex CLI·Claude Code의 최신 버전을 확인합니다.
              </p>
              {restartRequested && (
                <p className="text-[12px] font-medium text-sienna-600">
                  {mutation.isPending
                    ? "종료 요청을 처리하고 있습니다…"
                    : sawUnavailable
                      ? "새 서버가 준비될 때까지 연결을 확인하고 있습니다…"
                      : "서버 종료를 기다리고 있습니다…"}
                </p>
              )}
            </div>
            <div className="px-5 py-3 border-t border-sand-100/60 flex justify-end gap-2">
              {!restartRequested && (
                <button
                  type="button"
                  onClick={closeConfirmation}
                  className="px-3 py-1.5 text-[12px] rounded-lg text-sand-600 hover:bg-sand-100 transition-colors duration-150"
                >
                  취소
                </button>
              )}
              <button
                type="button"
                disabled={restartRequested || mutation.isPending}
                onClick={() => void restart()}
                className="px-3 py-1.5 text-[12px] font-medium rounded-lg bg-red-500 text-white hover:bg-red-600 disabled:opacity-50 transition-colors duration-150"
              >
                {restartRequested ? (mutation.isPending ? "요청 중" : "재연결 중") : "재시작"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function SettingsPanel() {
  const settingsQuery = SettingService.useSettingList();
  const { data, isLoading } = settingsQuery;

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

  if (settingsQuery.isError && !data) {
    return (
      <div className="panel px-5 py-6 text-center">
        <p className="text-[13px] font-medium text-sand-800">설정을 불러오지 못했습니다</p>
        <p className="mt-1 text-[11px] text-red-500">{settingsQuery.error.message}</p>
        <button
          type="button"
          onClick={() => void settingsQuery.refetch()}
          disabled={settingsQuery.isFetching}
          className="mt-3 px-3 py-1.5 text-[12px] rounded-lg border border-sand-200 text-sand-600 hover:bg-sand-100 disabled:opacity-50"
        >
          {settingsQuery.isFetching ? "다시 불러오는 중" : "다시 시도"}
        </button>
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
              {group === "slack" && <TriggerReminderButton />}
            </div>
            <div className="divide-y divide-sand-100/80">
              {items.map((item) => (
                <SettingRow key={item.key} item={item} />
              ))}
            </div>
          </div>
        );
      })}

      <RestartPanel supervisor={data?.supervisor ?? null} />
    </div>
  );
}
