import { EventEmitter } from "node:events";

import { Sonamu } from "sonamu";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetNativeRunRegistryForTests } from "../qgrid/qgrid-run-lifecycle";
import { resetServerRestartForTests } from "../../utils/server-restart";
import { SettingModel } from "./setting.model";

function installContext(headers: Record<string, string>) {
  const raw = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
  });
  vi.spyOn(Sonamu, "getContext").mockReturnValue({
    transport: "http",
    headers,
    request: { protocol: "http" },
    reply: { raw },
  } as never);
  return raw;
}

describe("SettingModel.restartServer", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    resetServerRestartForTests();
    resetNativeRunRegistryForTests();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("rejects restart when pm2 will not respawn the process", async () => {
    const raw = installContext({ host: "localhost:44900" });
    vi.stubEnv("pm_id", undefined);

    await expect(SettingModel.restartServer()).rejects.toMatchObject({ statusCode: 400 });
    expect(raw.listenerCount("finish")).toBe(0);
    expect(process.exit).not.toHaveBeenCalled();
  });

  it("rejects a browser request whose Origin host does not match Host", async () => {
    installContext({ origin: "https://evil.example", host: "qgrid.example.com" });
    vi.stubEnv("pm_id", "0");

    await expect(SettingModel.restartServer()).rejects.toMatchObject({ statusCode: 403 });
    expect(process.exit).not.toHaveBeenCalled();
  });

  it("rejects a malformed present Origin instead of treating it as an operational client", async () => {
    installContext({ origin: "null", host: "qgrid.example.com" });
    vi.stubEnv("pm_id", "0");

    await expect(SettingModel.restartServer()).rejects.toMatchObject({ statusCode: 403 });
    expect(process.exit).not.toHaveBeenCalled();
  });

  it("accepts a matching Origin using the Caddy-forwarded host", async () => {
    const raw = installContext({
      origin: "https://qgrid.example.com",
      host: "127.0.0.1:44900",
      "x-forwarded-host": "qgrid.example.com",
    });
    vi.stubEnv("pm_id", "0");

    await expect(SettingModel.restartServer()).resolves.toEqual({ supervisor: "pm2" });
    expect(process.exit).not.toHaveBeenCalled();

    raw.emit("finish");
    expect(process.exit).toHaveBeenCalledOnce();
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it("accepts an Origin-less operational request", async () => {
    const raw = installContext({ host: "qgrid.example.com" });
    vi.stubEnv("pm_id", "0");

    await expect(SettingModel.restartServer()).resolves.toEqual({ supervisor: "pm2" });
    expect(process.exit).not.toHaveBeenCalled();

    raw.emit("finish");
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it("coordinates simultaneous calls through one process exit", async () => {
    const firstRaw = installContext({ host: "qgrid.example.com" });
    vi.stubEnv("pm_id", "0");

    const first = SettingModel.restartServer();
    const second = SettingModel.restartServer();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { supervisor: "pm2" },
      { supervisor: "pm2" },
    ]);

    firstRaw.emit("finish");
    firstRaw.emit("close");
    expect(process.exit).toHaveBeenCalledOnce();
    expect(process.exit).toHaveBeenCalledWith(0);
  });
});
