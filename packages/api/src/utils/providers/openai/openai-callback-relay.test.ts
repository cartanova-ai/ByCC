import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  OPENAI_CALLBACK_PATH,
  OPENAI_CALLBACK_PORTS,
  openAICallbackRedirectUri,
  startOpenAICallbackRelay,
  stopOpenAICallbackRelay,
} from "./openai-callback-relay";

const DASHBOARD = "http://localhost:44900";

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = http.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

function occupy(port: number): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function get(url: string): Promise<{ status: number; location?: string }> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      response.resume();
      resolve({
        status: response.statusCode ?? 0,
        ...(response.headers.location ? { location: response.headers.location } : {}),
      });
    });
    request.on("error", reject);
  });
}

describe("openai callback relay", () => {
  const occupied: http.Server[] = [];

  afterEach(async () => {
    stopOpenAICallbackRelay();
    await Promise.all(occupied.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  it("pins the redirect URI to the ports OpenAI registered for the Codex CLI client", () => {
    expect(OPENAI_CALLBACK_PORTS).toEqual([1455, 1457]);
    expect(openAICallbackRedirectUri(1455)).toBe("http://localhost:1455/auth/callback");
  });

  it("forwards only code and state to the qgrid callback route", async () => {
    const port = await freePort();
    const redirectUri = await startOpenAICallbackRelay(DASHBOARD, 60_000, [port]);
    expect(redirectUri).toBe(`http://localhost:${port}${OPENAI_CALLBACK_PATH}`);

    const result = await get(
      `http://127.0.0.1:${port}${OPENAI_CALLBACK_PATH}?code=the-code&state=the-state&extra=x`,
    );

    expect(result.status).toBe(302);
    expect(result.location).toBe(
      `${DASHBOARD}${OPENAI_CALLBACK_PATH}?code=the-code&state=the-state`,
    );
  });

  it("answers 404 on any other path", async () => {
    const port = await freePort();
    await startOpenAICallbackRelay(DASHBOARD, 60_000, [port]);

    expect((await get(`http://127.0.0.1:${port}/callback?code=c&state=s`)).status).toBe(404);
  });

  it("falls back to the next registered port when the first is taken", async () => {
    const taken = await freePort();
    const fallback = await freePort();
    occupied.push(await occupy(taken));

    const redirectUri = await startOpenAICallbackRelay(DASHBOARD, 60_000, [taken, fallback]);

    expect(redirectUri).toBe(`http://localhost:${fallback}${OPENAI_CALLBACK_PATH}`);
  });

  it("reuses the running listener for a second login", async () => {
    const port = await freePort();
    const first = await startOpenAICallbackRelay(DASHBOARD, 60_000, [port]);
    const second = await startOpenAICallbackRelay(DASHBOARD, 60_000, [await freePort()]);

    expect(second).toBe(first);
  });

  it("fails when every registered port is taken", async () => {
    const a = await freePort();
    const b = await freePort();
    occupied.push(await occupy(a), await occupy(b));

    await expect(startOpenAICallbackRelay(DASHBOARD, 60_000, [a, b])).rejects.toThrow(
      /PORTS_UNAVAILABLE/,
    );
  });
});

