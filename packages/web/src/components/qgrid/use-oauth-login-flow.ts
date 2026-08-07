import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { QgridService } from "@/services/services.generated";

export type Provider = "anthropic" | "openai";

const OPENAI_POLL_INTERVAL_MS = 3000;
const OPENAI_POLL_TIMEOUT_MS = 300_000;

/** 캐시에 적재된 토큰 행 수. 폴링 조기 종료 판정에만 쓰는 근사치다. */
function countTokens(queryClient: ReturnType<typeof useQueryClient>): number {
  let total = 0;
  for (const query of queryClient.getQueryCache().findAll({ queryKey: ["Token"] })) {
    const rows = (query.state.data as { rows?: unknown[] } | undefined)?.rows;
    if (Array.isArray(rows)) total = Math.max(total, rows.length);
  }
  return total;
}

/**
 * provider별 OAuth 로그인 시작과 코드 제출을 한 곳에 모은다.
 * Add Token 모달과 tokens 목록의 재로그인 버튼이 같은 플로우를 쓴다 — 두 진입점이
 * redirect/code 분기나 폴링 처리를 각자 구현하면 원격 접속 경험이 갈라진다.
 */
export function useOAuthLoginFlow() {
  // 로그인 진행 중인 provider — 스피너를 해당 버튼에만 표시한다.
  const [loadingProvider, setLoadingProvider] = useState<Provider | null>(null);
  // 원격 접속(code 모드): 인증 후 표시된 코드를 붙여넣는 단계.
  const [codeEntry, setCodeEntry] = useState(false);

  const queryClient = useQueryClient();
  const oauthStartMutation = QgridService.useOauthStartMutation();
  const oauthStartOpenAIMutation = QgridService.useOauthStartOpenAIMutation();
  const oauthCompleteMutation = QgridService.useOauthCompleteMutation();

  // 폴링 타이머는 언마운트 시 반드시 정리한다 — 안 하면 모달을 닫거나 페이지를 떠나도
  // 최대 5분간 계속 refetch 가 돈다.
  const pollTimers = useRef<{ interval?: number; timeout?: number }>({});
  const stopPolling = () => {
    if (pollTimers.current.interval !== undefined) clearInterval(pollTimers.current.interval);
    if (pollTimers.current.timeout !== undefined) clearTimeout(pollTimers.current.timeout);
    pollTimers.current = {};
  };
  useEffect(() => stopPolling, []);

  const invalidateTokens = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["Token"] }),
      queryClient.invalidateQueries({ queryKey: ["Qgrid"] }),
    ]);

  const start = async (provider: Provider, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;

    // popup 을 동기적으로 열어야 브라우저가 차단하지 않음
    const popup = window.open("about:blank", "_blank");
    setLoadingProvider(provider);

    try {
      if (provider === "openai") {
        const { authUrl } = await oauthStartOpenAIMutation.mutateAsync({ name: trimmed });
        if (popup) popup.location.href = authUrl;
        else window.open(authUrl, "_blank");

        // codex 가 콜백을 처리하므로 토큰이 늘어날 때까지 폴링한다. 로그인이 끝나면
        // 바로 멈춰서, 성공한 뒤에도 남은 타임아웃 동안 계속 refetch 하지 않는다.
        const before = countTokens(queryClient);
        stopPolling();
        pollTimers.current.interval = window.setInterval(() => {
          void invalidateTokens().then(() => {
            if (countTokens(queryClient) > before) {
              stopPolling();
              setLoadingProvider(null);
            }
          });
        }, OPENAI_POLL_INTERVAL_MS);
        pollTimers.current.timeout = window.setTimeout(() => {
          stopPolling();
          setLoadingProvider(null);
        }, OPENAI_POLL_TIMEOUT_MS);
        return;
      }

      const { authUrl, mode } = await oauthStartMutation.mutateAsync({ name: trimmed });
      if (mode === "code") {
        // 원격 접속: 새 탭에서 인증 → 표시된 코드를 붙여넣는다.
        if (popup) popup.location.href = authUrl;
        else window.open(authUrl, "_blank");
        setCodeEntry(true);
        setLoadingProvider(null);
      } else {
        popup?.close();
        window.location.href = authUrl;
      }
    } catch (e) {
      popup?.close();
      console.error("OAuth start failed:", e);
      setLoadingProvider(null);
    }
  };

  /** @returns 교환 성공 여부. 실패 시 `completeMutation.isError` 로 안내 문구를 띄운다. */
  const submitCode = async (pastedCode: string): Promise<boolean> => {
    const trimmed = pastedCode.trim();
    if (!trimmed) return false;
    try {
      await oauthCompleteMutation.mutateAsync({ pastedCode: trimmed });
    } catch (e) {
      console.error("OAuth complete failed:", e);
      return false;
    }
    await invalidateTokens();
    return true;
  };

  const reset = () => {
    stopPolling();
    setLoadingProvider(null);
    setCodeEntry(false);
    oauthCompleteMutation.reset();
  };

  return {
    loadingProvider,
    codeEntry,
    start,
    submitCode,
    reset,
    completeMutation: oauthCompleteMutation,
  };
}
