import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ByccService } from "@/services/services.generated";
import EyeIcon from "~icons/lucide/eye";
import EyeOffIcon from "~icons/lucide/eye-off";
import PlusIcon from "~icons/lucide/plus";

export function AddTokenModal() {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const queryClient = useQueryClient();
  const addMutation = ByccService.useAddTokenMutation();

  const handleSubmit = async () => {
    const trimmed = token.trim();
    if (!trimmed) return;

    setError(null);
    try {
      const result = await addMutation.mutateAsync({
        token: trimmed,
        name: name.trim() || undefined,
      });
      if (!result.added) {
        setError("이미 등록된 토큰입니다");
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ["Bycc"] });
      setToken("");
      setName("");
      setShowToken(false);
      setOpen(false);
    } catch {
      setError("토큰 추가에 실패했습니다");
    }
  };

  const close = () => {
    setOpen(false);
    setToken("");
    setName("");
    setShowToken(false);
    setError(null);
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

          {/* Modal */}
          <div className="relative bg-white rounded-lg shadow-xl w-full max-w-md mx-4">
            <div className="px-5 py-4 border-b border-sand-100">
              <h2 className="text-base font-medium text-sand-900">Add Token</h2>
            </div>

            <div className="px-5 py-4 space-y-3">
              <div>
                <label
                  htmlFor="token-name"
                  className="text-[10px] uppercase tracking-wider text-sand-500 font-medium"
                >
                  Name
                </label>
                <input
                  id="token-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. prod, dev, team-a"
                  className="mt-1 w-full border border-sand-200 rounded-md px-3 py-2 text-sm text-sand-900 bg-white placeholder:text-sand-300 focus:outline-none focus:border-sienna-300"
                />
              </div>
              <div>
                <label
                  htmlFor="oauth-token"
                  className="text-[10px] uppercase tracking-wider text-sand-500 font-medium"
                >
                  OAuth Token *
                </label>
                <div className="relative mt-1">
                  <input
                    id="oauth-token"
                    type={showToken ? "text" : "password"}
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="Paste your OAuth token"
                    className="w-full border border-sand-200 rounded-md px-3 py-2 text-sm text-sand-900 bg-white placeholder:text-sand-300 focus:outline-none focus:border-sienna-300 pr-10"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleSubmit();
                    }}
                  />
                  <button
                    type="button"
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-sand-400 hover:text-sand-600 transition-colors duration-150"
                    onClick={() => setShowToken(!showToken)}
                  >
                    {showToken ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
                  </button>
                </div>
                {error && <p className="text-[11px] text-red-500 mt-1">{error}</p>}
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
              <button
                type="button"
                className="px-3 py-1 text-xs font-medium rounded-md bg-sienna-400 text-white hover:bg-sienna-500 disabled:opacity-50 transition-colors duration-150"
                disabled={!token.trim() || addMutation.isPending}
                onClick={handleSubmit}
              >
                {addMutation.isPending ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Adding...
                  </span>
                ) : (
                  "Add Token"
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
