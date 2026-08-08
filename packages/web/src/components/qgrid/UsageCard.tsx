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
import { Input } from "@sonamu-kit/react-components/components";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import GaugeIcon from "~icons/lucide/gauge";
import GripVerticalIcon from "~icons/lucide/grip-vertical";

import { formatUsd } from "@/lib/cost";
import { QgridService, TokenService } from "@/services/services.generated";
import { type TokenSubsetMapping } from "@/services/sonamu.generated";
import { useUpdateTokenMutation } from "@/services/token/use-update-token-mutation";

import { OAuthCodeEntry } from "./OAuthCodeEntry";
import { type Provider, useOAuthLoginFlow } from "./use-oauth-login-flow";

type Token = TokenSubsetMapping["A"];

// Quota gate 가 구현된 provider 에서만 threshold 편집/표시를 연다(거짓 UI 방지).
const QUOTA_THRESHOLD_PROVIDERS = new Set(["anthropic", "openai"]);

// threshold 입력(문자열) → 저장값(number|null) 검증.
// 빈 값 또는 0 = 해제(null, 제한 없음). 1..100 정수는 그대로. 소수/음수/100 초과는 거부.
function validateThreshold(
  raw: string,
): { ok: true; value: number | null } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (!/^\d+$/.test(trimmed)) return { ok: false, error: "정수만 입력하세요 (0–100)" };
  const n = Number(trimmed);
  if (n > 100) return { ok: false, error: "100 이하여야 합니다" };
  return { ok: true, value: n === 0 ? null : n };
}

function validateWeight(raw: string): { ok: true; value: number } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return { ok: false, error: "1–100 사이 정수를 입력하세요" };
  const value = Number(trimmed);
  if (value < 1 || value > 100) {
    return { ok: false, error: "1–100 사이 정수를 입력하세요" };
  }
  return { ok: true, value };
}

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

function formatWindowLabel(fallback: string, windowDurationMins?: number | null): string {
  if (!windowDurationMins || windowDurationMins <= 0) return fallback;

  const hours = windowDurationMins / 60;
  if (hours >= 24) return `${Math.round(hours / 24)}d`;
  return `${Math.round(hours)}h`;
}

function UsageRow({
  label,
  utilization,
  resetsAt,
  windowDurationMins,
  theme,
  threshold,
}: {
  label: string;
  utilization: number | null;
  resetsAt: string | null;
  windowDurationMins?: number | null;
  theme: ProviderTheme;
  // primary(5h) 행에만 전달. 설정 시 막대 위 그 % 위치에 제외선을 그린다. null이면 선 없음.
  threshold?: number | null;
}) {
  const pct = utilization ?? 0;
  const hasThreshold = threshold !== undefined && threshold !== null;
  return (
    // 고정 폭 합(w-20+w-10+w-24 = 216px)이 좁은 카드보다 커서 resets 가 밖으로 밀려났다.
    // 라벨·수치는 내용에 맞게 줄이고, resets 는 폭이 확보되는 sm 이상에서만 보여준다.
    <div className="flex items-center gap-2">
      <span className="text-xs text-sand-600 w-7 shrink-0">
        {formatWindowLabel(label, windowDurationMins)}
      </span>
      <div className="relative flex-1 min-w-0 h-2 bg-sand-200 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-300 ${barColor(pct, theme)}`}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
        {hasThreshold && (
          // 제외 임계선 — 사용률이 이 선에 닿으면 토큰이 풀에서 빠진다.
          <div
            className="absolute top-[-2px] bottom-[-2px] w-0.5 bg-sienna-500 rounded-full"
            style={{ left: `calc(${Math.min(threshold, 100)}% - 1px)` }}
          />
        )}
      </div>
      <span className="text-xs tabular-nums text-sand-700 w-9 text-right shrink-0">{pct}%</span>
      <span
        className="hidden sm:inline text-[10px] text-sand-400 w-24 text-right shrink-0"
        title={formatResets(resetsAt)}
      >
        {formatResets(resetsAt)}
      </span>
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

  // threshold 선은 gate 기준 window(primary = 5h 행)에만, 지원 provider일 때만.
  const thresholdForPrimary = QUOTA_THRESHOLD_PROVIDERS.has(token.provider)
    ? token.quota_threshold
    : null;

  return (
    <div className="space-y-1.5 py-1">
      {data.fiveHour && (
        <UsageRow
          label="5h"
          utilization={data.fiveHour.utilization}
          resetsAt={data.fiveHour.resetsAt}
          windowDurationMins={data.fiveHour.windowDurationMins}
          theme={theme}
          threshold={thresholdForPrimary}
        />
      )}
      {data.sevenDay && (
        <UsageRow
          label="7d"
          utilization={data.sevenDay.utilization}
          resetsAt={data.sevenDay.resetsAt}
          windowDurationMins={data.sevenDay.windowDurationMins}
          theme={theme}
        />
      )}
    </div>
  );
}

// 카드 내 threshold 설정. 트리거는 카드 안 작은 버튼, 편집은 트리거 좌표 기준 fixed 박스로
// 카드 위에 띄운다(카드 overflow-hidden + 그리드에 잘리지 않게 absolute 대신 fixed+좌표).
function ThresholdControl({ token }: { token: Token }) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [value, setValue] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const queryClient = useQueryClient();
  const updateMutation = useUpdateTokenMutation();

  const supported = QUOTA_THRESHOLD_PROVIDERS.has(token.provider);
  const open = pos !== null;
  const validation = validateThreshold(value);

  const POPOVER_WIDTH = 240; // w-60
  const POPOVER_EST_HEIGHT = 150; // 대략(라벨+입력+helper+버튼). flip 판정용 추정치.
  const MARGIN = 8;
  const GAP = 6;

  const openPopover = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    // left: 트리거 우변에 박스 우변을 맞추되 viewport [MARGIN, w-width-MARGIN] 로 clamp.
    const left = Math.min(
      Math.max(rect.right - POPOVER_WIDTH, MARGIN),
      Math.max(window.innerWidth - POPOVER_WIDTH - MARGIN, MARGIN),
    );
    // top: 기본은 버튼 위. 위 공간이 부족하면 아래로 flip. 최종적으로 viewport 안으로 clamp.
    const above = rect.top - GAP - POPOVER_EST_HEIGHT;
    const below = rect.bottom + GAP;
    const top = above >= MARGIN ? above : below;
    const clampedTop = Math.min(
      Math.max(top, MARGIN),
      Math.max(window.innerHeight - POPOVER_EST_HEIGHT - MARGIN, MARGIN),
    );
    setPos({ left, top: clampedTop });
    // 미설정이면 100에서 시작 — 거기서 -10 으로 내려가며 정하고, 0은 해제(null)로 저장한다.
    setValue(String(token.quota_threshold ?? 100));
  };

  const close = () => setPos(null);

  if (!supported) {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] text-sand-300 border border-sand-100"
        title="Quota threshold는 이 provider에서 지원되지 않습니다"
      >
        <GaugeIcon className="size-3" />
        n/a
      </span>
    );
  }

  // +10 / -10 버튼. 현재 입력을 숫자로 해석(빈 값/비정상은 0 기준)해 10 단위로 조정,
  // 0..100 으로 clamp. 0 = 제한 해제(저장 시 null). 직접 타이핑도 허용.
  const adjust = (delta: number) => {
    const current = /^\d+$/.test(value.trim()) ? Number(value.trim()) : 0;
    const next = Math.min(Math.max(current + delta, 0), 100);
    setValue(String(next));
  };

  const save = async () => {
    if (!validation.ok) return;
    await updateMutation.mutateAsync({
      id: token.id,
      quotaThreshold: validation.value,
    });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["Token"] }),
      queryClient.invalidateQueries({ queryKey: ["Qgrid"] }),
    ]);
    close();
  };

  return (
    <div className="inline-flex">
      <button
        ref={triggerRef}
        type="button"
        title="사용률 제한 설정"
        onClick={open ? close : openPopover}
        className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] border border-sand-200/80 text-sand-400 hover:text-sand-600 hover:border-sand-300 transition-colors duration-150"
      >
        <GaugeIcon className="size-3" />
        Set limit
      </button>

      {open && pos && (
        // 카드 위에 뜨는 작은 박스. 트리거 좌표 기준 fixed 라 카드 overflow-hidden·그리드에
        // 잘리지 않는다. 바깥 클릭(투명 오버레이)으로 닫힌다.
        <>
          <div className="fixed inset-0 z-40" onPointerDown={close} />
          <div
            className="fixed z-50 w-60 panel shadow-xl p-3"
            style={{ top: pos.top, left: pos.left }}
          >
            <label
              htmlFor={`threshold-${token.id}`}
              className="text-[10px] uppercase tracking-wider text-sand-500 font-medium"
            >
              사용률 제한
            </label>
            <div className="mt-1 flex items-center gap-2">
              <button
                type="button"
                onClick={() => adjust(-10)}
                className="size-9 shrink-0 rounded-md border border-sand-200 text-sand-600 text-base leading-none hover:bg-sand-100 transition-colors duration-150"
              >
                −
              </button>
              <Input
                id={`threshold-${token.id}`}
                value={value}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setValue(e.target.value)}
                inputMode="numeric"
                className={`h-9 w-14 border rounded-md text-center text-sm text-sand-900 bg-white tabular-nums focus:outline-none ${
                  validation.ok
                    ? "border-sand-200 focus:border-sienna-300"
                    : "border-red-300 focus:border-red-400"
                }`}
              />
              <button
                type="button"
                onClick={() => adjust(10)}
                className="size-9 shrink-0 rounded-md border border-sand-200 text-sand-600 text-base leading-none hover:bg-sand-100 transition-colors duration-150"
              >
                +
              </button>
              <span className="text-sm text-sand-500">%</span>
            </div>
            {validation.ok ? (
              <p className="mt-1.5 text-[11px] text-sand-500 leading-snug">
                {validation.value === null
                  ? "제한 없음 — 사용률과 무관하게 항상 사용합니다."
                  : "5h 사용률이 임계치에 달하면 해당 토큰을 건너뜁니다."}
              </p>
            ) : (
              <p className="mt-1.5 text-[11px] text-red-500">{validation.error}</p>
            )}
            <div className="mt-2 flex items-center justify-end gap-1.5">
              <button
                type="button"
                className="px-2 py-1 text-[11px] font-medium rounded-md border border-sand-200 text-sand-600 hover:bg-sand-100 transition-colors duration-150"
                onClick={close}
              >
                Cancel
              </button>
              <button
                type="button"
                className="px-2 py-1 text-[11px] font-medium rounded-md bg-sienna-400 text-white hover:bg-sienna-500 disabled:opacity-50 transition-colors duration-150"
                disabled={updateMutation.isPending || !validation.ok}
                onClick={save}
              >
                {updateMutation.isPending ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function WeightControl({ token }: { token: Token }) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [value, setValue] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const queryClient = useQueryClient();
  const updateMutation = useUpdateTokenMutation();
  const validation = validateWeight(value);

  const openPopover = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 240;
    const height = 150;
    const margin = 8;
    const gap = 6;
    const left = Math.min(
      Math.max(rect.right - width, margin),
      Math.max(window.innerWidth - width - margin, margin),
    );
    const above = rect.top - gap - height;
    const top = Math.min(
      Math.max(above >= margin ? above : rect.bottom + gap, margin),
      Math.max(window.innerHeight - height - margin, margin),
    );
    setValue(String(token.weight));
    setPos({ left, top });
  };

  const close = () => setPos(null);
  const adjust = (delta: number) => {
    const current = /^\d+$/.test(value.trim()) ? Number(value.trim()) : 1;
    setValue(String(Math.min(Math.max(current + delta, 1), 100)));
  };

  const save = async () => {
    if (!validation.ok) return;
    await updateMutation.mutateAsync({
      id: token.id,
      weight: validation.value,
    });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["Token"] }),
      queryClient.invalidateQueries({ queryKey: ["Qgrid"] }),
    ]);
    close();
  };

  return (
    <div className="inline-flex">
      <button
        ref={triggerRef}
        type="button"
        title="라우팅 가중치 설정"
        onClick={pos ? close : openPopover}
        className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] border border-sand-200/80 text-sand-400 hover:text-sand-600 hover:border-sand-300 transition-colors duration-150"
      >
        Weight {token.weight}
      </button>
      {pos && (
        <>
          <div className="fixed inset-0 z-40" onPointerDown={close} />
          <div className="fixed z-50 w-60 panel shadow-xl p-3" style={pos}>
            <label
              htmlFor={`weight-${token.id}`}
              className="text-[10px] uppercase tracking-wider text-sand-500 font-medium"
            >
              라우팅 가중치
            </label>
            <div className="mt-1 flex items-center gap-2">
              <button
                type="button"
                onClick={() => adjust(-1)}
                className="size-9 shrink-0 rounded-md border border-sand-200 text-sand-600"
              >
                −
              </button>
              <Input
                id={`weight-${token.id}`}
                value={value}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                  setValue(event.target.value)
                }
                inputMode="numeric"
                className={`h-9 w-16 border rounded-md text-center text-sm tabular-nums ${
                  validation.ok ? "border-sand-200" : "border-red-300"
                }`}
              />
              <button
                type="button"
                onClick={() => adjust(1)}
                className="size-9 shrink-0 rounded-md border border-sand-200 text-sand-600"
              >
                +
              </button>
            </div>
            <p className={`mt-1.5 text-[11px] ${validation.ok ? "text-sand-500" : "text-red-500"}`}>
              {validation.ok ? "새 요청의 상대 배정 비율입니다." : validation.error}
            </p>
            <div className="mt-2 flex items-center justify-end gap-1.5">
              <button type="button" onClick={close} className="px-2 py-1 text-[11px]">
                Cancel
              </button>
              <button
                type="button"
                onClick={save}
                disabled={updateMutation.isPending || !validation.ok}
                className="px-2 py-1 text-[11px] rounded-md bg-sienna-400 text-white disabled:opacity-50"
              >
                {updateMutation.isPending ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * 재로그인의 유일한 진입점.
 *
 * 조치가 필요하다는 것을 알게 되는 곳이 만료된 토큰 카드라, 거기서 바로 누를 수 있어야
 * 한다. Tokens 페이지에도 같은 버튼을 두었더니 같은 일을 두 곳에서 하게 돼 걷어냈다.
 *
 * `useOAuthLoginFlow` 는 Add Token 과 공유한다 — 원격 접속이면 코드 입력 단계로 이어지므로
 * 모달까지 이 컴포넌트가 함께 들고 있다.
 */
function ReloginButton({ token }: { token: Token }) {
  const oauth = useOAuthLoginFlow();

  const submitCode = async (pastedCode: string) => {
    if (await oauth.submitCode(pastedCode)) oauth.reset();
  };

  return (
    <>
      <button
        type="button"
        title="기존 이름으로 다시 로그인"
        disabled={oauth.loadingProvider !== null}
        onClick={() => void oauth.start(token.provider as Provider, token.name ?? "")}
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium border border-sienna-300 text-sienna-600 hover:bg-sienna-50 disabled:opacity-50 transition-colors duration-150"
      >
        {oauth.loadingProvider === token.provider ? (
          <>
            <span className="size-2.5 border-2 border-sienna-400 border-t-transparent rounded-full animate-spin" />
            로그인 대기
          </>
        ) : (
          "재로그인"
        )}
      </button>

      {oauth.codeEntry && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]">
          <div
            className="absolute inset-0 bg-sand-900/8 backdrop-blur-sm"
            onClick={oauth.reset}
            onKeyDown={() => {}}
          />
          <div className="relative panel shadow-xl w-full max-w-md mx-4">
            <div className="px-5 py-4 border-b border-sand-100/60">
              <h3 className="text-base font-medium text-sand-900">재로그인</h3>
            </div>
            <div className="px-5 py-4">
              <OAuthCodeEntry
                isPending={oauth.completeMutation.isPending}
                isError={oauth.completeMutation.isError}
                onSubmit={(code) => void submitCode(code)}
                onRestart={oauth.reset}
              />
            </div>
          </div>
        </div>
      )}
    </>
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
  const { data: costData } = QgridService.useTotalCost(
    { num: 0, page: 1, ...(token.name ? { token_name: token.name } : {}) },
    { enabled: !!token.name },
  );
  const theme = getProviderTheme(token.provider);

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  return (
    // 드래그는 grip 핸들에만 건다. 카드 전체에 걸면 touch-none 이 터치 스크롤까지 삼켜
    // 모바일에서 목록을 내릴 수 없고, 스크롤하려던 동작이 카드 재정렬로 잡힌다.
    <div
      ref={setNodeRef}
      style={style}
      className="relative rounded-lg bg-white border border-sand-200/80 overflow-hidden shadow-sm hover:shadow-md transition-shadow duration-200"
    >
      <div className={`absolute inset-y-0 left-0 w-1 ${theme.stripe}`} />
      {/* 배지를 absolute 로 띄우면 카드가 좁아질 때 토큰 이름 위에 겹친다. 전부 한 흐름에
          두고 wrap 시켜, 폭이 줄면 아래로 접히게 한다. */}
      <div className="pl-4 pr-3 py-3">
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <button
              type="button"
              aria-label="순서 변경 핸들"
              {...attributes}
              {...listeners}
              className="shrink-0 -m-1 p-1 text-sand-300 hover:text-sand-500 cursor-grab active:cursor-grabbing touch-none"
            >
              <GripVerticalIcon className="size-3.5" />
            </button>
            <span className="text-[13px] font-medium text-sand-800 truncate select-none">
              {token.name ?? "Unnamed"}
            </span>
          </div>
          <span
            className={`text-[11px] tabular-nums font-medium shrink-0 ${theme.cost}`}
            title="이 토큰의 누적 비용"
          >
            {formatUsd(costData?.usd ?? 0)}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1 mb-2">
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full uppercase ${theme.badge}`}>
            {token.provider}
          </span>
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded-full ${token.active ? "bg-sage-100 text-sage-600" : "bg-sand-200 text-sand-500"}`}
          >
            {token.active ? "Active" : "Inactive"}
          </span>
          {QUOTA_THRESHOLD_PROVIDERS.has(token.provider) && token.quota_threshold !== null && (
            <span
              className="px-1.5 py-0.5 rounded-full bg-sienna-50 text-[10px] tabular-nums font-medium text-sienna-600"
              title={`사용률 ${token.quota_threshold}% 이상이면 이 토큰 제외`}
            >
              ≤ {token.quota_threshold}%
            </span>
          )}
        </div>
        <TokenUsage token={token} theme={theme} />
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {/* 만료를 확인하는 곳이 대시보드인데 조치는 Tokens 페이지에서만 되면 동선이
              어긋난다. 조치가 필요한 카드에서 바로 재로그인한다. */}
          {!token.active && <ReloginButton token={token} />}
          <div className="flex-1" />
          <WeightControl token={token} />
          <ThresholdControl token={token} />
        </div>
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
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
