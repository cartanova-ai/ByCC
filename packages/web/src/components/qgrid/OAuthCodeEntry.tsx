import { Input } from "@sonamu-kit/react-components/components";
import { useState } from "react";

/**
 * 원격 접속(code 모드) Claude 로그인의 코드 입력 단계.
 * Add Token 모달과 재로그인이 같은 문구·에러·재시작 동선을 쓰도록 한 곳에 둔다.
 */
export function OAuthCodeEntry({
  isPending,
  isError,
  onSubmit,
  onRestart,
}: {
  isPending: boolean;
  isError: boolean;
  onSubmit: (pastedCode: string) => void;
  onRestart: () => void;
}) {
  const [pastedCode, setPastedCode] = useState("");

  return (
    <div className="space-y-2">
      <p className="text-[12px] text-sand-600 leading-relaxed">
        새 탭에서 Claude 로그인을 완료하면 코드가 표시됩니다. 코드 전체를 아래에 붙여넣으세요.
      </p>
      <Input
        value={pastedCode}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPastedCode(e.target.value)}
        placeholder="code#state"
        className="w-full border border-sand-200 rounded-md px-3 py-2 text-sm font-mono text-sand-900 bg-white placeholder:text-sand-300 focus:outline-none focus:border-sienna-300"
      />
      {isError && (
        <p className="text-[11px] text-red-500">
          코드 확인에 실패했습니다 — 표시된 코드 전체를 다시 붙여넣거나 로그인을 다시 시작하세요.
        </p>
      )}
      <button
        type="button"
        className="w-full py-2.5 text-sm font-medium rounded-md bg-sand-900 text-white hover:bg-sand-800 disabled:opacity-50 transition-colors duration-150 flex items-center justify-center gap-2"
        disabled={!pastedCode.trim() || isPending}
        onClick={() => onSubmit(pastedCode)}
      >
        {isPending ? (
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
          setPastedCode("");
          onRestart();
        }}
      >
        처음부터 다시 시작
      </button>
    </div>
  );
}
