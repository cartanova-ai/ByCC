import { describe, expect, it, vi } from "vitest";

const { latest } = vi.hoisted(() => ({ latest: vi.fn() }));

vi.mock("./application/token/token.model", () => ({
  TokenModel: {
    getDB: () => ({ migrate: { latest } }),
  },
}));

import { runRequiredMigrations } from "./startup-migrations";

describe("required startup migrations", () => {
  it("terminates with a failure status when migration fails", async () => {
    const failure = new Error("tokens.weight migration failed");
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw failure;
    });
    latest.mockRejectedValueOnce(failure);

    await expect(runRequiredMigrations()).rejects.toBe(failure);

    expect(exit).toHaveBeenCalledWith(1);
  });
});
