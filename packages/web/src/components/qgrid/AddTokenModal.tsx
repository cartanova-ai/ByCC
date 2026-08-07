import { Input } from "@sonamu-kit/react-components/components";
import { useState } from "react";
import KeyIcon from "~icons/lucide/key-round";
import PlusIcon from "~icons/lucide/plus";

import { OAuthCodeEntry } from "./OAuthCodeEntry";
import { type Provider, useOAuthLoginFlow } from "./use-oauth-login-flow";

export function AddTokenModal() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const oauth = useOAuthLoginFlow();

  const close = () => {
    setOpen(false);
    setName("");
    oauth.reset();
  };

  const handleOAuthLogin = (provider: Provider) => void oauth.start(provider, name);

  const submitPastedCode = async (pastedCode: string) => {
    if (await oauth.submitCode(pastedCode)) close();
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
              {oauth.codeEntry ? (
                <OAuthCodeEntry
                  isPending={oauth.completeMutation.isPending}
                  isError={oauth.completeMutation.isError}
                  onSubmit={(code) => void submitPastedCode(code)}
                  onRestart={oauth.reset}
                />
              ) : (
                <div className="space-y-2">
                  <button
                    type="button"
                    className="w-full py-2.5 text-sm font-medium rounded-md bg-sand-900 text-white hover:bg-sand-800 disabled:opacity-50 transition-colors duration-150 flex items-center justify-center gap-2"
                    disabled={!name.trim() || oauth.loadingProvider !== null}
                    onClick={() => handleOAuthLogin("openai")}
                  >
                    {oauth.loadingProvider === "openai" ? (
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
                    disabled={!name.trim() || oauth.loadingProvider !== null}
                    onClick={() => handleOAuthLogin("anthropic")}
                  >
                    {oauth.loadingProvider === "anthropic" ? (
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
