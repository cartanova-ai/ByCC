import { Input } from "@sonamu-kit/react-components/components";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import PencilIcon from "~icons/lucide/pencil";
import TrashIcon from "~icons/lucide/trash-2";

import { QgridService } from "@/services/services.generated";
import { type TokenSubsetMapping } from "@/services/sonamu.generated";
import { useUpdateTokenMutation } from "@/services/token/use-update-token-mutation";

import { OAuthCodeEntry } from "./OAuthCodeEntry";
import { type Provider, useOAuthLoginFlow } from "./use-oauth-login-flow";

type Token = TokenSubsetMapping["A"];

function getExpiresAt(token: Token): number | null {
  const c = token.credentials;
  if ("expiresAt" in c && typeof c.expiresAt === "number") return c.expiresAt;
  if ("accessTokenExpiresAt" in c && typeof c.accessTokenExpiresAt === "number")
    return c.accessTokenExpiresAt;
  return null;
}

function formatExpiry(expiresAt: number | null): { text: string; color: string } {
  if (!expiresAt) return { text: "", color: "" };
  const diff = expiresAt - Date.now();
  if (diff <= 0) return { text: "expired", color: "text-red-500" };
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  const text = h > 0 ? `${h}h ${m}m` : `${m}m`;
  if (diff < 3_600_000) return { text, color: "text-amber-500" };
  return { text, color: "text-sand-400" };
}

function maskAccessToken(token: Token): string {
  const at = token.credentials.accessToken;
  if (at.length <= 12) return at;
  return `${at.slice(0, 8)}...${at.slice(-4)}`;
}

interface TokenTableProps {
  data: Token[] | undefined;
  isLoading: boolean;
}

export function TokenTable({ data, isLoading }: TokenTableProps) {
  const [deleteTarget, setDeleteTarget] = useState<Token | null>(null);
  const [editTarget, setEditTarget] = useState<Token | null>(null);
  const [editName, setEditName] = useState("");

  const queryClient = useQueryClient();
  const removeMutation = QgridService.useRemoveTokenMutation();
  const updateMutation = useUpdateTokenMutation();
  const toggleMutation = QgridService.useToggleTokenMutation();
  // 재로그인은 Add Token 과 같은 플로우를 쓴다 — 원격 접속이면 코드 입력 단계로 이어진다.
  const oauth = useOAuthLoginFlow();

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["Token"] }),
      queryClient.invalidateQueries({ queryKey: ["Qgrid"] }),
    ]);

  const handleToggle = async (token: Token) => {
    await toggleMutation.mutateAsync({ id: token.id });
    await invalidate();
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    await removeMutation.mutateAsync({ id: deleteTarget.id });
    await invalidate();
    setDeleteTarget(null);
  };

  const submitReloginCode = async (pastedCode: string) => {
    if (await oauth.submitCode(pastedCode)) oauth.reset();
  };

  const openEdit = (token: Token) => {
    setEditTarget(token);
    setEditName(token.name ?? "");
  };

  const handleUpdate = async () => {
    if (!editTarget) return;
    // threshold 는 UsageCard 에서 설정한다. 여기선 name 만 바꾸고 기존 threshold 는 보존한다.
    await updateMutation.mutateAsync({
      id: editTarget.id,
      name: editName.trim(),
    });
    await invalidate();
    setEditTarget(null);
  };

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={`skeleton-${i}`} className="h-12 bg-sand-100 rounded-md animate-pulse" />
        ))}
      </div>
    );
  }

  const tokens = data ?? [];

  if (tokens.length === 0) {
    return (
      <div className="text-sand-400 text-center py-16 text-sm">
        No tokens registered. Click <strong className="text-sand-600">Add Token</strong> to get
        started.
      </div>
    );
  }

  return (
    <>
      <div className="panel overflow-hidden">
        {/* 컬럼이 좁은 화면보다 넓다. 표를 줄이는 대신 표만 가로로 스크롤시켜
            페이지 자체가 밀리지 않게 한다. */}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-[13px]">
            <thead>
              <tr className="panel-header">
                <th className="text-left px-5 py-2.5 text-[10px] uppercase tracking-wider text-sand-400 font-medium">
                  Provider
                </th>
                <th className="text-left px-5 py-2.5 text-[10px] uppercase tracking-wider text-sand-400 font-medium">
                  Name
                </th>
                <th className="text-left px-5 py-2.5 text-[10px] uppercase tracking-wider text-sand-400 font-medium">
                  Token
                </th>
                <th className="text-left px-5 py-2.5 text-[10px] uppercase tracking-wider text-sand-400 font-medium">
                  Status
                </th>
                <th className="text-left px-5 py-2.5 text-[10px] uppercase tracking-wider text-sand-400 font-medium">
                  Expires
                </th>
                <th className="w-20 px-3 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-sand-100/80">
              {tokens.map((token) => {
                const expiry = formatExpiry(getExpiresAt(token));
                return (
                  <tr
                    key={token.id}
                    className={`transition-colors duration-150 hover:bg-sand-100/60 ${token.active ? "" : "opacity-50"}`}
                  >
                    <td className="px-5 py-3">
                      <span className="text-xs font-medium text-sand-500 uppercase">
                        {token.provider}
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      {token.name ? (
                        <span className="text-sm text-sand-700">{token.name}</span>
                      ) : (
                        <span className="text-[11px] text-sand-400">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <code className="text-[13px] font-mono text-sand-800">
                        {maskAccessToken(token)}
                      </code>
                    </td>
                    <td className="px-5 py-3">
                      <button
                        type="button"
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200 ${token.active ? "bg-sage-400" : "bg-sand-300"}`}
                        onClick={() => handleToggle(token)}
                        disabled={toggleMutation.isPending}
                      >
                        <span
                          className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform duration-200 ${token.active ? "translate-x-4.5" : "translate-x-0.5"}`}
                        />
                      </button>
                    </td>
                    <td className="px-5 py-3">
                      {expiry.text && (
                        <span className={`text-xs ${expiry.color}`}>{expiry.text}</span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-1">
                        {!token.active && (
                          <button
                            type="button"
                            title="기존 이름으로 다시 로그인"
                            className="px-2 py-0.5 mr-1 text-[11px] font-medium rounded-md border border-sand-300 text-sand-600 hover:bg-sand-100 disabled:opacity-50 transition-colors duration-150 inline-flex items-center gap-1"
                            disabled={oauth.loadingProvider !== null}
                            onClick={() =>
                              void oauth.start(token.provider as Provider, token.name ?? "")
                            }
                          >
                            {oauth.loadingProvider === token.provider ? (
                              <>
                                <span className="w-3 h-3 border-2 border-sand-400 border-t-transparent rounded-full animate-spin" />
                                로그인 대기
                              </>
                            ) : (
                              "재로그인"
                            )}
                          </button>
                        )}
                        <button
                          type="button"
                          className="p-1 rounded text-sand-400 hover:text-sienna-500 transition-colors duration-150"
                          onClick={() => openEdit(token)}
                        >
                          <PencilIcon className="size-4" />
                        </button>
                        <button
                          type="button"
                          className="p-1 rounded text-sand-400 hover:text-red-500 transition-colors duration-150"
                          onClick={() => setDeleteTarget(token)}
                        >
                          <TrashIcon className="size-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* 재로그인 코드 입력 (원격 접속 code 모드) */}
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
                onSubmit={(code) => void submitReloginCode(code)}
                onRestart={oauth.reset}
              />
            </div>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editTarget && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]">
          <div
            className="absolute inset-0 bg-sand-900/8 backdrop-blur-sm"
            onClick={() => setEditTarget(null)}
            onKeyDown={() => {}}
          />
          <div className="relative panel shadow-xl w-full max-w-sm mx-4">
            <div className="px-5 py-4 border-b border-sand-100/60">
              <h3 className="text-base font-medium text-sand-900">Edit Token</h3>
            </div>
            <div className="px-5 py-4 space-y-3">
              <div>
                <label
                  htmlFor="token-name"
                  className="text-[10px] uppercase tracking-wider text-sand-500 font-medium"
                >
                  Name
                </label>
                <Input
                  value={editName}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditName(e.target.value)}
                  placeholder="e.g. prod, dev, team-a"
                  className="mt-1 w-full border border-sand-200 rounded-md px-3 py-2 text-sm text-sand-900 bg-white placeholder:text-sand-300 focus:outline-none focus:border-sienna-300"
                />
              </div>
            </div>
            <div className="px-5 py-3 border-t border-sand-100/60 flex items-center justify-end gap-2">
              <button
                type="button"
                className="px-3 py-1 text-xs font-medium rounded-md border border-sand-200 text-sand-600 hover:bg-sand-100 transition-colors duration-150"
                onClick={() => setEditTarget(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="px-3 py-1 text-xs font-medium rounded-md bg-sienna-400 text-white hover:bg-sienna-500 disabled:opacity-50 transition-colors duration-150"
                disabled={updateMutation.isPending}
                onClick={handleUpdate}
              >
                {updateMutation.isPending ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]">
          <div
            className="absolute inset-0 bg-sand-900/8 backdrop-blur-sm"
            onClick={() => setDeleteTarget(null)}
            onKeyDown={() => {}}
          />
          <div className="relative panel shadow-xl w-full max-w-sm mx-4">
            <div className="px-5 py-4">
              <h3 className="text-base font-medium text-sand-900">Remove Token</h3>
              <p className="text-sm text-sand-700 mt-2">
                Are you sure you want to remove{" "}
                <code className="text-[13px] font-mono text-sand-800">
                  {maskAccessToken(deleteTarget)}
                </code>
                {deleteTarget.name && <span className="text-sand-500"> ({deleteTarget.name})</span>}
                ?
              </p>
            </div>
            <div className="px-5 py-3 border-t border-sand-100/60 flex items-center justify-end gap-2">
              <button
                type="button"
                className="px-3 py-1 text-xs font-medium rounded-md border border-sand-200 text-sand-600 hover:bg-sand-100 transition-colors duration-150"
                onClick={() => setDeleteTarget(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="px-3 py-1 text-xs font-medium rounded-md bg-red-500 text-white hover:bg-red-600 disabled:opacity-50 transition-colors duration-150"
                disabled={removeMutation.isPending}
                onClick={handleDelete}
              >
                {removeMutation.isPending ? "Removing..." : "Remove"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
