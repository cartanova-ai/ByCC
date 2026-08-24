import http from "node:http";

import { getLogger } from "@logtape/logtape";

const logger = getLogger(["qgrid", "oauth"]);

/**
 * OpenAI matches the Codex CLI client's redirect URIs by exact string, and only these two loopback
 * callbacks are registered. Any other host, port, or path makes /oauth/authorize fail with
 * `invalid_authorize_request` before the login screen renders, so qgrid cannot point the callback
 * at its own configurable server port. Keep in sync with the Codex CLI allow-list (default 1455,
 * fallback 1457).
 */
export const OPENAI_CALLBACK_PORTS = [1455, 1457] as const;
export const OPENAI_CALLBACK_PATH = "/auth/callback";

export function openAICallbackRedirectUri(port: number): string {
  return `http://localhost:${port}${OPENAI_CALLBACK_PATH}`;
}

type Relay = {
  server: http.Server;
  redirectUri: string;
  dashboardBase: string;
  expiryTimer: NodeJS.Timeout;
};

let relay: Relay | null = null;

function forward(request: http.IncomingMessage, response: http.ServerResponse): void {
  const current = relay;
  const incoming = new URL(request.url ?? "/", "http://localhost");
  if (!current || incoming.pathname !== OPENAI_CALLBACK_PATH) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("not found");
    return;
  }

  // Only the two OAuth result fields cross over, onto a fixed loopback base. The request never
  // contributes scheme, authority, or path bytes to the redirect target.
  const target = new URL(OPENAI_CALLBACK_PATH, current.dashboardBase);
  for (const field of ["code", "state"] as const) {
    const value = incoming.searchParams.get(field);
    if (value) target.searchParams.set(field, value);
  }
  response.writeHead(302, { Location: target.toString(), "Cache-Control": "no-store" });
  response.end();
}

function listenOn(port: number): Promise<http.Server | null> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(forward);
    server.once("error", (error: NodeJS.ErrnoException) => {
      server.close();
      if (error.code === "EADDRINUSE" || error.code === "EACCES") resolve(null);
      else reject(error);
    });
    // Bind loopback only, like the Codex CLI: the relay must not be reachable off-host.
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

/**
 * Opens a short-lived loopback listener on a registered Codex callback port and forwards the
 * authorization code to qgrid own callback route. Returns the redirect URI to put in the authorize
 * request. Repeated logins reuse the running listener and refresh its lifetime.
 */
export async function startOpenAICallbackRelay(
  dashboardBase: string,
  ttlMs: number,
  ports: readonly number[] = OPENAI_CALLBACK_PORTS,
): Promise<string> {
  if (relay) {
    relay.dashboardBase = dashboardBase;
    relay.expiryTimer.refresh();
    return relay.redirectUri;
  }

  for (const port of ports) {
    const server = await listenOn(port);
    if (!server) continue;

    const expiryTimer = setTimeout(() => stopOpenAICallbackRelay(), ttlMs);
    expiryTimer.unref();
    const address = server.address();
    const boundPort = typeof address === "object" && address ? address.port : port;
    relay = {
      server,
      redirectUri: openAICallbackRedirectUri(boundPort),
      dashboardBase,
      expiryTimer,
    };
    logger.info(`openai oauth callback relay listening on 127.0.0.1:${boundPort}`);
    return relay.redirectUri;
  }

  throw new Error(`OPENAI_CALLBACK_PORTS_UNAVAILABLE_${ports.join("_")}`);
}

export function stopOpenAICallbackRelay(): void {
  if (!relay) return;
  clearTimeout(relay.expiryTimer);
  relay.server.close();
  relay = null;
}
