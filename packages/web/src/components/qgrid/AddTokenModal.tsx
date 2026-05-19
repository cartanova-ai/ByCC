import { Input } from "@sonamu-kit/react-components/components";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import KeyIcon from "~icons/lucide/key-round";
import PlusIcon from "~icons/lucide/plus";

import { QgridService } from "@/services/services.generated";

type Provider = "anthropic" | "openai";

export function AddTokenModal() {
  const [open, setOpen] = useState(false);
  const [oauthLoading, setOauthLoading] = useState(false);
  const [name, setName] = useState("");

  const queryClient = useQueryClient();
  const oauthStartMutation = QgridService.useOauthStartMutation();
  const oauthStartOpenAIMutation = QgridService.useOauthStartOpenAIMutation();

  const handleOAuthLogin = async (provider: Provider) => {
    if (!name.trim()) return;

    if (provider === "openai") {
      // popup 을 동기적으로 열어야 브라우저가 차단하지 않음
      const popup = window.open("about:blank", "_blank");
      setOauthLoading(true);
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
          setOauthLoading(false);
        }, 300_000);
      } catch (e) {
        console.error("OAuth start failed:", e);
        setOauthLoading(false);
      }
    } else {
      setOauthLoading(true);
      try {
        const { authUrl } = await oauthStartMutation.mutateAsync({ name: name.trim() });
        window.location.href = authUrl;
      } catch (e) {
        console.error("OAuth start failed:", e);
        setOauthLoading(false);
      }
    }
  };

  const close = () => {
    setOpen(false);
    setName("");
    setOauthLoading(false);
  };

  return (
    <>
      <button
        type="button"
        className="px-3 py-1 text-xs font-medium rounded-md bg-sienna-400 text-white hover:bg-sienna-500 disabled:opacity-50 transition-colors duration-150 active:scale-[0.98] flex items-center gap-1"
        onClick={() => setOpen(true)}
      >
        <PlusIcon className="size-3.5" />
        Add Token
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]">
          <div className="absolute inset-0" onClick={close} onKeyDown={() => {}} />

          <div className="relative bg-white rounded-lg shadow-xl w-full max-w-md mx-4">
            <div className="px-5 py-4 border-b border-sand-100">
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

              {/* Provider buttons */}
              <div className="space-y-2">
                <button
                  type="button"
                  className="w-full py-2.5 text-sm font-medium rounded-md bg-sand-900 text-white hover:bg-sand-800 disabled:opacity-50 transition-colors duration-150 flex items-center justify-center gap-2"
                  disabled={!name.trim() || oauthLoading}
                  onClick={() => handleOAuthLogin("openai")}
                >
                  {oauthLoading ? (
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
                  disabled={!name.trim() || oauthLoading}
                  onClick={() => handleOAuthLogin("anthropic")}
                >
                  <KeyIcon className="size-4" />
                  Login with Claude
                </button>
              </div>
            </div>

            <div className="px-5 py-3 border-t border-sand-100 flex items-center justify-end gap-2">
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
