export function createTtftTracker(now: () => number = Date.now): {
  markStart: () => void;
  recordFirstDelta: () => void;
  value: () => number | null;
  wrapDelta: (onDelta: (text: string) => void) => (text: string) => void;
} {
  let startedAt: number | null = null;
  let ttftMs: number | null = null;

  const recordFirstDelta = () => {
    if (startedAt === null || ttftMs !== null) return;
    ttftMs = Math.max(0, now() - startedAt);
  };

  return {
    markStart: () => {
      startedAt = now();
    },
    recordFirstDelta,
    value: () => ttftMs,
    wrapDelta: (onDelta) => (text) => {
      recordFirstDelta();
      onDelta(text);
    },
  };
}
