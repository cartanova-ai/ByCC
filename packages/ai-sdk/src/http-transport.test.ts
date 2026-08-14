import { describe, expect, it } from "vitest";

import {
  anthropicTransportOptions,
  toQgridTransportError,
} from "./http-transport";

describe("qgrid HTTP transport", () => {
  it("keeps the default Anthropic transport budget above the server timeout", () => {
    expect(anthropicTransportOptions()).toEqual({
      headersTimeout: 300_000,
      bodyTimeout: 300_000,
    });
  });

  it("derives both Undici timeouts from timeoutMs with response grace", () => {
    expect(anthropicTransportOptions(600_000)).toEqual({
      headersTimeout: 660_000,
      bodyTimeout: 660_000,
    });
  });

  it("finds connection errors nested inside an AggregateError", () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:44900"), {
      code: "ECONNREFUSED",
    });
    const error = new TypeError("fetch failed", {
      cause: new AggregateError([refused]),
    });

    expect(
      toQgridTransportError(error, {
        operation: "query",
        serverUrl: "http://localhost:44900",
      }).message,
    ).toBe(
      "qgrid query transport failed: connection refused by http://localhost:44900 (ECONNREFUSED)",
    );
  });

  it("identifies response body timeouts", () => {
    const cause = Object.assign(new Error("Body Timeout Error"), {
      code: "UND_ERR_BODY_TIMEOUT",
    });

    expect(
      toQgridTransportError(new TypeError("fetch failed", { cause }), {
        operation: "query",
        serverUrl: "http://localhost:44900",
        transportTimeoutMs: 660_000,
      }).message,
    ).toBe(
      "qgrid query transport failed: response body timed out after 660000ms (UND_ERR_BODY_TIMEOUT)",
    );
  });

  it("preserves AbortError so AI SDK cancellation semantics remain intact", () => {
    const error = new DOMException("This operation was aborted", "AbortError");

    expect(
      toQgridTransportError(error, {
        operation: "query",
        serverUrl: "http://localhost:44900",
      }),
    ).toBe(error);
  });
});
