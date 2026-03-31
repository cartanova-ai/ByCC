import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { TokenStats } from "@/services/bycc/bycc.types";
import { maskToken } from "@/services/bycc/bycc.types";
import { ByccService } from "@/services/services.generated";
import CheckIcon from "~icons/lucide/check";
import CopyIcon from "~icons/lucide/copy";
import EyeIcon from "~icons/lucide/eye";
import EyeOffIcon from "~icons/lucide/eye-off";
import PencilIcon from "~icons/lucide/pencil";
import TrashIcon from "~icons/lucide/trash-2";
import { StatusBadge } from "./StatusBadge";

interface TokenTableProps {
  data: TokenStats[] | undefined;
  isLoading: boolean;
}

export function TokenTable({ data, isLoading }: TokenTableProps) {
  const [deleteTarget, setDeleteTarget] = useState<TokenStats | null>(null);
  const [editTarget, setEditTarget] = useState<TokenStats | null>(null);
  const [editName, setEditName] = useState("");
  const [editToken, setEditToken] = useState("");
  const [showEditToken, setShowEditToken] = useState(false);
  const [copiedToken, setCopiedToken] = useState(false);

  const queryClient = useQueryClient();
  const removeMutation = ByccService.useRemoveTokenMutation();
  const updateMutation = ByccService.useUpdateTokenMutation();

  const handleDelete = async () => {
    if (!deleteTarget) return;
    await removeMutation.mutateAsync({ token: deleteTarget.token });
    await queryClient.invalidateQueries({ queryKey: ["Bycc"] });
    setDeleteTarget(null);
  };

  const openEdit = (token: TokenStats) => {
    setEditTarget(token);
    setEditName(token.name ?? "");
    setEditToken("");
    setShowEditToken(false);
    setCopiedToken(false);
  };

  const handleUpdate = async () => {
    if (!editTarget) return;
    await updateMutation.mutateAsync({
      token: editTarget.token,
      name: editName.trim(),
      newToken: editToken.trim(),
    });
    await queryClient.invalidateQueries({ queryKey: ["Bycc"] });
    setEditTarget(null);
  };

  const handleCopyToken = () => {
    if (!editTarget) return;
    navigator.clipboard.writeText(editTarget.token);
    setCopiedToken(true);
    setTimeout(() => setCopiedToken(false), 1500);
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
      <div className="rounded-lg bg-sand-50 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-sand-200">
              <th className="text-left px-5 py-3 text-[10px] uppercase tracking-wider text-sand-400 font-medium">
                Token
              </th>
              <th className="text-left px-5 py-3 text-[10px] uppercase tracking-wider text-sand-400 font-medium">
                Name
              </th>
              <th className="text-left px-5 py-3 text-[10px] uppercase tracking-wider text-sand-400 font-medium">
                Status
              </th>
              <th className="text-right px-5 py-3 text-[10px] uppercase tracking-wider text-sand-400 font-medium">
                Requests
              </th>
              <th className="w-16 px-3 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-sand-200/60">
            {tokens.map((token) => (
              <tr
                key={token.token}
                className={`transition-colors duration-150 hover:bg-sand-100/60 ${
                  token.active ? "" : "opacity-50"
                }`}
              >
                <td className="px-5 py-3">
                  <code className="text-[13px] font-mono text-sand-800">
                    {maskToken(token.token)}
                  </code>
                </td>
                <td className="px-5 py-3">
                  {token.name ? (
                    <span className="text-sm text-sand-700">{token.name}</span>
                  ) : (
                    <span className="text-[11px] text-sand-400">—</span>
                  )}
                </td>
                <td className="px-5 py-3">
                  <StatusBadge active={token.active} />
                </td>
                <td className="px-5 py-3 text-right tabular-nums text-sand-700">
                  {token.requests.toLocaleString()}
                </td>
                <td className="px-3 py-3">
                  <div className="flex items-center gap-1">
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
            ))}
          </tbody>
        </table>
      </div>

      {/* Edit Modal */}
      {editTarget && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]">
          <div
            className="absolute inset-0"
            onClick={() => setEditTarget(null)}
            onKeyDown={() => {}}
          />
          <div className="relative bg-white rounded-lg shadow-xl w-full max-w-sm mx-4">
            <div className="px-5 py-4 border-b border-sand-100">
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
                <input
                  id="token-name"
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder="e.g. prod, dev, team-a"
                  className="mt-1 w-full border border-sand-200 rounded-md px-3 py-2 text-sm text-sand-900 bg-white placeholder:text-sand-300 focus:outline-none focus:border-sienna-300"
                />
              </div>
              <div>
                <div className="flex items-center justify-between">
                  <label
                    htmlFor="token-value"
                    className="text-[10px] uppercase tracking-wider text-sand-500 font-medium"
                  >
                    Token
                  </label>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="flex items-center gap-1 text-[10px] text-sand-400 hover:text-sienna-500 transition-colors duration-150"
                      onClick={handleCopyToken}
                    >
                      {copiedToken ? (
                        <>
                          <CheckIcon className="size-3 text-sage-500" />
                          <span className="text-sage-500">Copied</span>
                        </>
                      ) : (
                        <>
                          <CopyIcon className="size-3" />
                          <span>Copy</span>
                        </>
                      )}
                    </button>
                    <button
                      type="button"
                      className="flex items-center gap-1 text-[10px] text-sand-400 hover:text-sand-600 transition-colors duration-150"
                      onClick={() => setShowEditToken(!showEditToken)}
                    >
                      {showEditToken ? (
                        <>
                          <EyeOffIcon className="size-3" />
                          <span>Hide</span>
                        </>
                      ) : (
                        <>
                          <EyeIcon className="size-3" />
                          <span>Show</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
                <input
                  id="token-value"
                  type={showEditToken ? "text" : "password"}
                  value={editToken || (showEditToken ? editTarget.token : "")}
                  onChange={(e) => setEditToken(e.target.value)}
                  placeholder={showEditToken ? "" : "●●●●●●●●●●●●●●●●"}
                  className="mt-1 w-full border border-sand-200 rounded-md px-3 py-2 text-sm text-sand-900 bg-white placeholder:text-sand-400 focus:outline-none focus:border-sienna-300"
                />
              </div>
            </div>
            <div className="px-5 py-3 border-t border-sand-100 flex items-center justify-end gap-2">
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
            className="absolute inset-0"
            onClick={() => setDeleteTarget(null)}
            onKeyDown={() => {}}
          />
          <div className="relative bg-white rounded-lg shadow-xl w-full max-w-sm mx-4">
            <div className="px-5 py-4">
              <h3 className="text-base font-medium text-sand-900">Remove Token</h3>
              <p className="text-sm text-sand-700 mt-2">
                Are you sure you want to remove{" "}
                <code className="text-[13px] font-mono text-sand-800">
                  {maskToken(deleteTarget.token)}
                </code>
                {deleteTarget.name && <span className="text-sand-500"> ({deleteTarget.name})</span>}
                ?
              </p>
            </div>
            <div className="px-5 py-3 border-t border-sand-100 flex items-center justify-end gap-2">
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
                {removeMutation.isPending ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Removing...
                  </span>
                ) : (
                  "Remove"
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
