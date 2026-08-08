import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  armServerRestartExit,
  beginServerRestart,
  isRestartPending,
  resetServerRestartForTests,
} from "./server-restart";

describe("server restart coordination", () => {
  afterEach(() => {
    resetServerRestartForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("exits exactly once after the first response finishes", () => {
    const raw = new EventEmitter();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    expect(beginServerRestart()).toBe(true);
    expect(beginServerRestart()).toBe(false);
    expect(isRestartPending()).toBe(true);
    expect(exit).not.toHaveBeenCalled();

    armServerRestartExit(raw as never);
    raw.emit("finish");
    raw.emit("finish");

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("uses a finite fallback when the response never finishes", () => {
    vi.useFakeTimers();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    beginServerRestart();
    armServerRestartExit(new EventEmitter() as never);
    vi.advanceTimersByTime(4_999);
    expect(exit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("exits once when the client disconnects before the response finishes", () => {
    const raw = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    beginServerRestart();
    armServerRestartExit(raw as never);
    raw.emit("close");
    raw.emit("finish");

    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("does not exit before reconciliation arms the response lifecycle", () => {
    vi.useFakeTimers();
    const raw = Object.assign(new EventEmitter(), { destroyed: true, writableEnded: false });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    beginServerRestart();
    raw.emit("close");
    vi.advanceTimersByTime(5_000);
    expect(exit).not.toHaveBeenCalled();

    armServerRestartExit(raw as never);
    expect(exit).toHaveBeenCalledOnce();
  });
});
