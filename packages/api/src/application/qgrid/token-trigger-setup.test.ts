import { describe, expect, it } from "vitest";

import { TOKENS_TRIGGER_SETUP_SQL } from "./token-trigger-setup";

describe("tokens trigger setup", () => {
  it("leaves weight notifications to the versioned migration trigger", () => {
    expect(TOKENS_TRIGGER_SETUP_SQL).not.toContain("OLD.weight IS DISTINCT FROM NEW.weight");
  });
});
