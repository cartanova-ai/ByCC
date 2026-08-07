import { Input } from "@sonamu-kit/react-components/components";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import KeyIcon from "~icons/lucide/key-round";
import PlusIcon from "~icons/lucide/plus";

import { QgridService } from "@/services/services.generated";

type Provider = "anthropic" | "openai";

export function AddTokenModal() {
  const [open, setOpen] = useState(false);
  // 로그인 진행 중인 provider — 스피너를 해당 버튼에만 표시한다.
  const [oauthLoading, setOauthLoading] = useState<Provider | null>(null);
  const [name, setName] = useState("");
  // 원격 접속(code 모드) Claude 로그인: 인증 후 표시된 코드를 붙여넣는 단계.
  const [codeEntry, setCodeEntry] = useState(false);
  const [pastedCode, setPastedCode] = useState("");

  const queryClient = useQueryClient();
  const oauthStartMutation = QgridService.useOauthStartMutation();
  const oauthStartOpenAIMutation = QgridService.useOauthStartOpenAIMutation();
  const oauthCompleteMutation = QgridService.useOauthCompleteMutation();

  const handleOAuthLogin = async (provider: Provider) => {
    if (!name.trim()) return;

    if (provider === "openai") {
      // popup 을 동기적으로 열어야 브라우저가 차단하지 않음
      const popup = window.open("about:blank", "_blank");
      setOauthLoading("openai");
      try {
        const { authUrl } = await oauthStartOpenAIMutation.mutateAsync({ name: name.trim() });
        if (popup) popup.location.href = authUrl;
        else window.open(authUrl, "_blank");

        // polling: 토큰 목록이 바뀔 때까지 대기
        const poll = setInterval(async () => {
          await queryClient.invalidateQueries({ queryKey: ["Token"] });
          await queryClient.invalidateQueries({ queryKey: ["Qgrid"] });
        }, 3000);

        // 5분 후 자동 정리
        setTimeout(() => {
          clearInterval(poll);
          setOauthLoading(null);
        }, 300_000);
      } catch (e) {
        console.error("OAuth start failed:", e);
        setOauthLoading(null);
      }
    } else {
      // code 모드에서 새 탭이 필요하므로 팝업을 동기적으로 미리 연다 (차단 방지)
      const popup = window.open("about:blank", "_blank");
      setOauthLoading("anthropic");
      try {
        const { authUrl, mode } = await oauthStartMutation.mutateAsync({ name: name.trim() });
        if (mode === "code") {
          // 원격 접속: 새 탭에서 인증 → 표시된 코드를 이 모달에 붙여넣는다.
          if (popup) popup.location.href = authUrl;
          else window.open(authUrl, "_blank");
          setCodeEntry(true);
          setOauthLoading(null);
        } else {
          popup?.close();
          window.location.href = authUrl;
        }
      } catch (e) {
        popup?.close();
        console.error("OAuth start failed:", e);
        setOauthLoading(null);
      }
    }
  };

  const submitPastedCode = async () => {
    if (!pastedCode.trim()) return;
    try {
      await oauthCompleteMutation.mutateAsync({ pastedCode: pastedCode.trim() });
    } catch (e) {
      console.error("OAuth complete failed:", e);
      return; // isError 상태로 안내 문구 표시
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["Token"] }),
      queryClient.invalidateQueries({ queryKey: ["Qgrid"] }),
    ]);
    close();
  };

  const close = () => {
    setOpen(false);
    setName("");
    setOauthLoading(null);
    setCodeEntry(false);
    setPastedCode("");
    oauthCompleteMutation.reset();
  };

  return (
    <>
      <button
        type="button"
        className="px-3.5 py-1.5 text-[12px] font-medium rounded-lg bg-sienna-500 text-white hover:bg-sienna-600 disabled:opacity-50 transition-all duration-150 active:scale-[0.97] flex items-center gap-1.5 shadow-sm"
        onClick={() => setOpen(true)}
      >
        <PlusIcon className="size-3.5" />
        Add Token
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]">
          <div
            className="absolute inset-0 bg-sand-900/8 backdrop-blur-sm"
            onClick={close}
            onKeyDown={() => {}}
          />

          <div className="relative panel shadow-xl w-full max-w-md mx-4">
            <div className="px-5 py-4 border-b border-sand-100/50">
              <h2 className="text-base font-medium text-sand-900">Add Token</h2>
            </div>

            <div className="px-5 py-4 space-y-4">
              {/* Name */}
              <div>
                <label
                  htmlFor="token-name"
                  className="text-[10px] uppercase tracking-wider text-sand-500 font-medium"
                >
                  Name *
                </label>
                <Input
                  value={name}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
                  placeholder="e.g. your-token-name"
                  className="mt-1 w-full border border-sand-200 rounded-md px-3 py-2 text-sm text-sand-900 bg-white placeholder:text-sand-300 focus:outline-none focus:border-sienna-300"
                />
              </div>

              {/* Provider buttons / 코드 입력 단계 */}
              {codeEntry ? (
                <div className="space-y-2">
                  <p className="text-[12px] text-sand-600 leading-relaxed">
                    새 탭에서 Claude 로그인을 완료하면 코드가 표시됩니다. 코드 전체를 아래에
                    붙여넣으세요.
                  </p>
                  <Input
                    value={pastedCode}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      setPastedCode(e.target.value)
                    }
                    placeholder="code#state"
                    className="w-full border border-sand-200 rounded-md px-3 py-2 text-sm font-mono text-sand-900 bg-white placeholder:text-sand-300 focus:outline-none focus:border-sienna-300"
                  />
                  {oauthCompleteMutation.isError && (
                    <p className="text-[11px] text-red-500">
                      코드 확인에 실패했습니다 — 표시된 코드 전체를 다시 붙여넣거나 로그인을 다시
                      시작하세요.
                    </p>
                  )}
                  <button
                    type="button"
                    className="w-full py-2.5 text-sm font-medium rounded-md bg-sand-900 text-white hover:bg-sand-800 disabled:opacity-50 transition-colors duration-150 flex items-center justify-center gap-2"
                    disabled={!pastedCode.trim() || oauthCompleteMutation.isPending}
                    onClick={submitPastedCode}
                  >
                    {oauthCompleteMutation.isPending ? (
                      <span className="flex items-center gap-1.5">
                        <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                        Verifying...
                      </span>
                    ) : (
                      "Complete login"
                    )}
                  </button>
                  <button
                    type="button"
                    className="w-full py-1.5 text-[12px] text-sand-500 hover:text-sand-700 transition-colors duration-150"
                    onClick={() => {
                      setCodeEntry(false);
                      setPastedCode("");
                      oauthCompleteMutation.reset();
                    }}
                  >
                    처음부터 다시 시작
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  <button
                    type="button"
                    className="w-full py-2.5 text-sm font-medium rounded-md bg-sand-900 text-white hover:bg-sand-800 disabled:opacity-50 transition-colors duration-150 flex items-center justify-center gap-2"
                    disabled={!name.trim() || oauthLoading !== null}
                    onClick={() => handleOAuthLogin("openai")}
                  >
                    {oauthLoading === "openai" ? (
                      <span className="flex items-center gap-1.5">
                        <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                        Waiting for login...
                      </span>
                    ) : (
                      <>
                        <KeyIcon className="size-4" />
                        Login with OpenAI
                      </>
                    )}
                  </button>

                  <div className="flex items-center gap-3">
                    <div className="flex-1 h-px bg-sand-200" />
                    <span className="text-[10px] text-sand-400 uppercase">or</span>
                    <div className="flex-1 h-px bg-sand-200" />
                  </div>

                  <button
                    type="button"
                    className="w-full py-2.5 text-sm font-medium rounded-md border border-sand-300 text-sand-700 hover:bg-sand-100 disabled:opacity-50 transition-colors duration-150 flex items-center justify-center gap-2"
                    disabled={!name.trim() || oauthLoading !== null}
                    onClick={() => handleOAuthLogin("anthropic")}
                  >
                    {oauthLoading === "anthropic" ? (
                      <span className="flex items-center gap-1.5">
                        <span className="w-3.5 h-3.5 border-2 border-sand-400 border-t-transparent rounded-full animate-spin" />
                        Waiting for login...
                      </span>
                    ) : (
                      <>
                        <KeyIcon className="size-4" />
                        Login with Claude
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>

            <div className="px-5 py-3 border-t border-sand-100/50 flex items-center justify-end gap-2">
              <button
                type="button"
                className="px-3 py-1 text-xs font-medium rounded-md border border-sand-200 text-sand-600 hover:bg-sand-100 transition-colors duration-150"
                onClick={close}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
