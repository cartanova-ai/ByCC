import { describe, expect, it } from "vitest";

import { MAX_OPENAI_PERMITS_PER_TOKEN, resolveOpenAIPermitConfig } from "./openai-permit-config";

describe("resolveOpenAIPermitConfig", () => {
  it("reads capacity from the compatible maximum-worker key", () => {
    expect(resolveOpenAIPermitConfig({ QGRID_OPENAI_MAX_WORKERS_PER_TOKEN: "7" })).toEqual({
      permitsPerToken: 7,
      transport: "https",
    });
  });

  it("retains the disabled-autoscale minimum-worker interpretation", () => {
    expect(
      resolveOpenAIPermitConfig({
        QGRID_OPENAI_AUTOSCALE: "false",
        QGRID_OPENAI_MIN_WORKERS_PER_TOKEN: "2",
        QGRID_OPENAI_MAX_WORKERS_PER_TOKEN: "9",
      }),
    ).toEqual({ permitsPerToken: 2, transport: "https" });
  });

  it("bounds invalid and excessive capacity", () => {
    expect(resolveOpenAIPermitConfig({ QGRID_OPENAI_MAX_WORKERS_PER_TOKEN: "invalid" })).toEqual({
      permitsPerToken: 3,
      transport: "https",
    });
    expect(resolveOpenAIPermitConfig({ QGRID_OPENAI_MAX_WORKERS_PER_TOKEN: "999" })).toEqual({
      permitsPerToken: MAX_OPENAI_PERMITS_PER_TOKEN,
      transport: "https",
    });
  });

  it("selects websocket explicitly and rejects invalid values", () => {
    expect(resolveOpenAIPermitConfig({ QGRID_OPENAI_TRANSPORT: "websocket" })).toEqual({
      permitsPerToken: 3,
      transport: "websocket",
    });
    expect(() => resolveOpenAIPermitConfig({ QGRID_OPENAI_TRANSPORT: "auto" })).toThrow(
      "Invalid QGRID_OPENAI_TRANSPORT value: auto",
    );
  });
});
