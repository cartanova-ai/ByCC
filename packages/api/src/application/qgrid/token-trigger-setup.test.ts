import { describe, expect, it } from "vitest";

import { TOKENS_TRIGGER_SETUP_SQL } from "./token-trigger-setup";

describe("tokens trigger setup", () => {
  it("leaves weight notifications to the versioned migration trigger", () => {
    expect(TOKENS_TRIGGER_SETUP_SQL).not.toContain("OLD.weight IS DISTINCT FROM NEW.weight");
  });

  it("notifies subscribers when per-token keepalive membership changes", () => {
    expect(TOKENS_TRIGGER_SETUP_SQL).toContain(
      "OLD.keepalive_enabled IS DISTINCT FROM NEW.keepalive_enabled",
    );
  });

  it("notifies subscribers when a token starts requiring re-login", () => {
    expect(TOKENS_TRIGGER_SETUP_SQL).toContain(
      "OLD.reauth_required IS DISTINCT FROM NEW.reauth_required",
    );
  });
});
