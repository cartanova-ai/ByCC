import { Agent, type Dispatcher } from "undici";

import { type QgridSupportedModel } from "./index.types";

const DEFAULT_ANTHROPIC_TIMEOUT_MS = 240_000;
const TRANSPORT_RESPONSE_GRACE_MS = 60_000;

type TransportOperation = "query";

type ErrorLike = {
  cause?: unknown;
  code?: unknown;
  errors?: unknown;
  message?: unknown;
  name?: unknown;
};

export type QgridRequestInit = RequestInit & {
  dispatcher?: Dispatcher;
};

export type QgridRequestTransport = {
  dispatcher: Dispatcher;
  timeoutMs: number;
};

export type QgridTransportErrorContext = {
  operation: TransportOperation;
  serverUrl: string;
  transportTimeoutMs?: number;
};

export function anthropicTransportOptions(timeoutMs?: number): {
  headersTimeout: number;
  bodyTimeout: number;
} {
  const providerTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs !== undefined && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_ANTHROPIC_TIMEOUT_MS;
  const transportTimeoutMs = providerTimeoutMs + TRANSPORT_RESPONSE_GRACE_MS;

  return {
    headersTimeout: transportTimeoutMs,
    bodyTimeout: transportTimeoutMs,
  };
}

export function createQgridRequestTransport(
  modelId: QgridSupportedModel,
  timeoutMs?: number,
): QgridRequestTransport | undefined {
  if (!modelId.startsWith("anthropic/")) return undefined;

  const options = anthropicTransportOptions(timeoutMs);
  return {
    dispatcher: new Agent(options),
    timeoutMs: options.headersTimeout,
  };
}

export async function closeQgridRequestTransport(
  transport: QgridRequestTransport | undefined,
): Promise<void> {
  if (!transport) return;
  await transport.dispatcher.close().catch(() => undefined);
}

export async function qgridFetch(
  input: string | URL,
  init: QgridRequestInit,
  context: QgridTransportErrorContext,
): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (error) {
    throw toQgridTransportError(error, context);
  }
}

export function toQgridTransportError(error: unknown, context: QgridTransportErrorContext): Error {
  if (isAbortError(error)) return error;

  const code = findErrorCode(error);
  const prefix = `qgrid ${context.operation} transport failed`;

  if (code === "UND_ERR_HEADERS_TIMEOUT") {
    const budget = context.transportTimeoutMs ? ` after ${context.transportTimeoutMs}ms` : "";
    return new Error(`${prefix}: response headers timed out${budget} (${code})`, {
      cause: error,
    });
  }

  if (code === "UND_ERR_BODY_TIMEOUT") {
    const budget = context.transportTimeoutMs ? ` after ${context.transportTimeoutMs}ms` : "";
    return new Error(`${prefix}: response body timed out${budget} (${code})`, {
      cause: error,
    });
  }

  if (code === "ECONNREFUSED") {
    return new Error(
      `${prefix}: connection refused by ${serverOrigin(context.serverUrl)} (${code})`,
      { cause: error },
    );
  }

  const detail = findDeepestMessage(error) ?? "unknown network error";
  return new Error(`${prefix}: ${detail}${code ? ` (${code})` : ""}`, {
    cause: error,
  });
}

function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === "AbortError";
}

function findErrorCode(error: unknown, seen = new Set<unknown>()): string | undefined {
  if (!isErrorLike(error) || seen.has(error)) return undefined;
  seen.add(error);

  if (typeof error.code === "string") return error.code;

  const causeCode = findErrorCode(error.cause, seen);
  if (causeCode) return causeCode;

  if (Array.isArray(error.errors)) {
    for (const nested of error.errors) {
      const nestedCode = findErrorCode(nested, seen);
      if (nestedCode) return nestedCode;
    }
  }

  return undefined;
}

function findDeepestMessage(error: unknown, seen = new Set<unknown>()): string | undefined {
  if (!isErrorLike(error) || seen.has(error)) return undefined;
  seen.add(error);

  const causeMessage = findDeepestMessage(error.cause, seen);
  if (causeMessage) return causeMessage;

  if (Array.isArray(error.errors)) {
    for (const nested of error.errors) {
      const nestedMessage = findDeepestMessage(nested, seen);
      if (nestedMessage) return nestedMessage;
    }
  }

  return typeof error.message === "string" && error.message.length > 0 ? error.message : undefined;
}

function isErrorLike(value: unknown): value is ErrorLike & object {
  return typeof value === "object" && value !== null;
}

function serverOrigin(serverUrl: string): string {
  try {
    return new URL(serverUrl).origin;
  } catch {
    return serverUrl;
  }
}
