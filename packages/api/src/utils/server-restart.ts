import { type ServerResponse } from "node:http";

const RESTART_EXIT_FALLBACK_MS = 5_000;

let restartPending = false;
let exitTriggered = false;
let exitArmed = false;
let fallbackTimer: NodeJS.Timeout | undefined;
let armedReplyRaw: ReplyRaw | undefined;
let armedExit: (() => void) | undefined;

type ReplyRaw = Pick<ServerResponse, "once" | "removeListener" | "destroyed" | "writableEnded">;

/** 재시작 요청 뒤에는 새 native provider 실행을 받지 않는다. */
export function isRestartPending(): boolean {
  return restartPending;
}

/**
 * 프로세스 전체에서 최초 요청만 재시작을 시작한다. 종료 신호는 active run 정합성 처리가
 * 끝난 뒤 별도로 arm 한다. 그래야 이미 닫힌 연결이나 fallback 타이머가 DB 정리보다 앞서
 * 프로세스를 끝내지 않는다.
 */
export function beginServerRestart(): boolean {
  if (restartPending) return false;
  restartPending = true;
  return true;
}

function clearExitArm(): void {
  if (fallbackTimer) clearTimeout(fallbackTimer);
  fallbackTimer = undefined;
  if (armedReplyRaw && armedExit) {
    armedReplyRaw.removeListener("finish", armedExit);
    armedReplyRaw.removeListener("close", armedExit);
  }
  armedReplyRaw = undefined;
  armedExit = undefined;
}

/** 정합성 처리가 끝난 뒤 HTTP 응답 flush/연결 종료/유한 fallback 중 먼저 온 신호로 종료한다. */
export function armServerRestartExit(replyRaw: ReplyRaw): void {
  if (!restartPending || exitArmed) return;
  exitArmed = true;

  const exitOnce = () => {
    if (exitTriggered) return;
    exitTriggered = true;
    clearExitArm();
    process.exit(0);
  };

  armedReplyRaw = replyRaw;
  armedExit = exitOnce;
  replyRaw.once("finish", exitOnce);
  replyRaw.once("close", exitOnce);
  fallbackTimer = setTimeout(exitOnce, RESTART_EXIT_FALLBACK_MS);
  fallbackTimer.unref();
  if (replyRaw.destroyed && !replyRaw.writableEnded) exitOnce();
}

/** 모듈 전역 상태를 격리해야 하는 단위 테스트 전용. */
export function resetServerRestartForTests(): void {
  clearExitArm();
  restartPending = false;
  exitTriggered = false;
  exitArmed = false;
}
