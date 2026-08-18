import { getLogger } from "@logtape/logtape";

import { TokenModel } from "../token/token.model";
import { QgridFrame } from "./qgrid.frame";
import { type InternalQueryInput } from "./qgrid.dispatcher";
import { type UsageResponse } from "./qgrid.types";

const logger = getLogger(["qgrid", "token-window-keepalive"]);

const FIVE_HOURS_MS = 5 * 60 * 60 * 1_000;
const RESET_GRACE_MS = 1_000;

// usage API 성공 응답은 1분 캐시된다. keepalive 직후 즉시 재조회하면 이전 윈도우를
// 다시 보므로 캐시가 지난 뒤 한 번 확인하고, 그때도 새 윈도우가 없으면 다음 5h까지 기다린다.
export const POST_KEEPALIVE_USAGE_DELAY_MS = 61_000;
export const KEEPALIVE_MODEL = "anthropic/claude-haiku-4-5";
export const KEEPALIVE_PROJECT_NAME = "qgrid-token-window-keepalive";

type KeepaliveToken = {
  id: number;
  name: string;
  provider: string;
  active: boolean;
};

type TimerHandle = ReturnType<typeof setTimeout>;

export type TokenWindowKeepaliveDeps = {
  findTokens: () => Promise<KeepaliveToken[]>;
  readUsage: (tokenId: number) => Promise<UsageResponse>;
  dispatch: (input: InternalQueryInput) => Promise<unknown>;
  now: () => number;
  setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer: (handle: TimerHandle) => void;
};

const defaultDeps: TokenWindowKeepaliveDeps = {
  findTokens: () => TokenModel.findActive("A"),
  readUsage: (tokenId) => QgridFrame.usage(tokenId),
  dispatch: (input) => QgridFrame.query(input),
  now: () => Date.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (handle) => clearTimeout(handle),
};

const timers = new Map<number, { handle: TimerHandle; clear: (handle: TimerHandle) => void }>();
let generation = 0;

function clearTokenTimer(tokenId: number): void {
  const timer = timers.get(tokenId);
  if (!timer) return;
  timer.clear(timer.handle);
  timers.delete(tokenId);
}

function scheduleToken(
  token: KeepaliveToken,
  deps: TokenWindowKeepaliveDeps,
  expectedGeneration: number,
  delayMs: number,
  allowFire: boolean,
): void {
  if (generation !== expectedGeneration) return;
  clearTokenTimer(token.id);
  const handle = deps.setTimer(() => {
    timers.delete(token.id);
    if (generation !== expectedGeneration) return;
    void inspectToken(token, deps, expectedGeneration, allowFire).catch((error) => {
      logger.warn(`keepalive cycle failed for ${token.name}: ${(error as Error).message}`);
      scheduleToken(token, deps, expectedGeneration, FIVE_HOURS_MS, true);
    });
  }, Math.max(0, delayMs));
  timers.set(token.id, { handle, clear: deps.clearTimer });
}

function scheduleFallback(
  token: KeepaliveToken,
  deps: TokenWindowKeepaliveDeps,
  expectedGeneration: number,
): void {
  scheduleToken(token, deps, expectedGeneration, FIVE_HOURS_MS, true);
}

async function inspectToken(
  token: KeepaliveToken,
  deps: TokenWindowKeepaliveDeps,
  expectedGeneration: number,
  allowFire: boolean,
): Promise<void> {
  let usage: UsageResponse;
  try {
    usage = await deps.readUsage(token.id);
  } catch (error) {
    logger.warn(`usage lookup failed for ${token.name}: ${(error as Error).message}`);
    scheduleFallback(token, deps, expectedGeneration);
    return;
  }
  if (generation !== expectedGeneration) return;

  if (usage.error) {
    logger.warn(`usage lookup failed for ${token.name}: ${usage.error}`);
    scheduleFallback(token, deps, expectedGeneration);
    return;
  }

  const resetsAt = usage.fiveHour?.resetsAt;
  if (resetsAt) {
    const resetMs = Date.parse(resetsAt);
    if (!Number.isFinite(resetMs)) {
      logger.warn(`invalid five-hour reset for ${token.name}: ${resetsAt}`);
      scheduleFallback(token, deps, expectedGeneration);
      return;
    }
    if (resetMs > deps.now()) {
      scheduleToken(
        token,
        deps,
        expectedGeneration,
        resetMs - deps.now() + RESET_GRACE_MS,
        true,
      );
      return;
    }
  }

  // 발사 직후 확인에서는 캐시된 null/과거 reset을 봐도 다시 발사하지 않는다.
  if (!allowFire) {
    scheduleFallback(token, deps, expectedGeneration);
    return;
  }

  try {
    await deps.dispatch({
      prompt: "Reply OK.",
      model: KEEPALIVE_MODEL,
      effort: "low",
      projectName: KEEPALIVE_PROJECT_NAME,
      preferredTokenId: token.id,
    });
    logger.info(`keepalive sent for ${token.name}`);
  } catch (error) {
    logger.warn(`keepalive failed for ${token.name}: ${(error as Error).message}`);
    scheduleFallback(token, deps, expectedGeneration);
    return;
  }

  scheduleToken(
    token,
    deps,
    expectedGeneration,
    POST_KEEPALIVE_USAGE_DELAY_MS,
    false,
  );
}

export async function startTokenWindowKeepalive(
  deps: TokenWindowKeepaliveDeps = defaultDeps,
): Promise<void> {
  stopTokenWindowKeepalive();
  const expectedGeneration = generation;

  let tokens: KeepaliveToken[];
  try {
    tokens = await deps.findTokens();
  } catch (error) {
    logger.warn(`token discovery failed: ${(error as Error).message}`);
    return;
  }
  if (generation !== expectedGeneration) return;

  const targets = tokens.filter((token) => token.active && token.provider === "anthropic");
  logger.info(`token window keepalive scheduling ${targets.length} token(s)`);
  await Promise.all(
    targets.map((token) => inspectToken(token, deps, expectedGeneration, true)),
  );
}

export function rescheduleTokenWindowKeepalive(
  deps: TokenWindowKeepaliveDeps = defaultDeps,
): Promise<void> {
  return startTokenWindowKeepalive(deps);
}

export function stopTokenWindowKeepalive(): void {
  generation++;
  for (const tokenId of [...timers.keys()]) clearTokenTimer(tokenId);
}
