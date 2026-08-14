import { describe, expect, it } from "vitest";

import { MAX_OPENAI_PERMITS_PER_TOKEN, resolveOpenAIPermitConfig } from "./openai-permit-config";

describe("resolveOpenAIPermitConfig", () => {
  it("reads capacity from the canonical permits key", () => {
    expect(resolveOpenAIPermitConfig({ QGRID_OPENAI_PERMITS_PER_TOKEN: "5" })).toEqual({
      permitsPerToken: 5,
      transport: "websocket",
    });
  });

  it("prefers the canonical key over every legacy key", () => {
    expect(
      resolveOpenAIPermitConfig({
        QGRID_OPENAI_PERMITS_PER_TOKEN: "5",
        QGRID_OPENAI_AUTOSCALE: "false",
        QGRID_OPENAI_MIN_WORKERS_PER_TOKEN: "2",
        QGRID_OPENAI_MAX_WORKERS_PER_TOKEN: "9",
      }),
    ).toEqual({ permitsPerToken: 5, transport: "websocket" });
  });

  it("falls back to the legacy maximum-worker key", () => {
    expect(resolveOpenAIPermitConfig({ QGRID_OPENAI_MAX_WORKERS_PER_TOKEN: "7" })).toEqual({
      permitsPerToken: 7,
      transport: "websocket",
    });
  });

  it("retains the disabled-autoscale minimum-worker interpretation", () => {
    expect(
      resolveOpenAIPermitConfig({
        QGRID_OPENAI_AUTOSCALE: "false",
        QGRID_OPENAI_MIN_WORKERS_PER_TOKEN: "2",
        QGRID_OPENAI_MAX_WORKERS_PER_TOKEN: "9",
      }),
    ).toEqual({ permitsPerToken: 2, transport: "websocket" });
  });

  it("bounds invalid and excessive capacity", () => {
    expect(resolveOpenAIPermitConfig({ QGRID_OPENAI_PERMITS_PER_TOKEN: "invalid" })).toEqual({
      permitsPerToken: 3,
      transport: "websocket",
    });
    expect(resolveOpenAIPermitConfig({ QGRID_OPENAI_PERMITS_PER_TOKEN: "999" })).toEqual({
      permitsPerToken: MAX_OPENAI_PERMITS_PER_TOKEN,
      transport: "websocket",
    });
    expect(resolveOpenAIPermitConfig({ QGRID_OPENAI_MAX_WORKERS_PER_TOKEN: "999" })).toEqual({
      permitsPerToken: MAX_OPENAI_PERMITS_PER_TOKEN,
      transport: "websocket",
    });
  });

  it("defaults to 3 permits when no key is set", () => {
    expect(resolveOpenAIPermitConfig({})).toEqual({ permitsPerToken: 3, transport: "websocket" });
  });

  it("selects HTTPS explicitly and rejects invalid values", () => {
    expect(resolveOpenAIPermitConfig({ QGRID_OPENAI_TRANSPORT: "https" })).toEqual({
      permitsPerToken: 3,
      transport: "https",
    });
    expect(() => resolveOpenAIPermitConfig({ QGRID_OPENAI_TRANSPORT: "auto" })).toThrow(
      "Invalid QGRID_OPENAI_TRANSPORT value: auto",
    );
  });
});
