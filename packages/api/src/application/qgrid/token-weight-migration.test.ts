import { type Knex } from "knex";
import { describe, expect, it, vi } from "vitest";

import { down, up } from "../../migrations/20260710090000_alter_tokens_add_weight";

function fakeKnex() {
  const raw = vi.fn().mockResolvedValue(undefined);
  const table = {
    integer: vi.fn(() => ({
      notNullable: vi.fn(() => ({ defaultTo: vi.fn() })),
    })),
    dropColumns: vi.fn(),
  };
  const alterTable = vi.fn(async (_name: string, callback: (value: typeof table) => void) => {
    callback(table);
  });
  return {
    knex: { raw, schema: { alterTable } } as unknown as Knex,
    raw,
  };
}

describe("tokens weight migration", () => {
  it("installs a versioned trigger that old bootstrap code cannot replace", async () => {
    const { knex, raw } = fakeKnex();

    await up(knex);

    expect(raw).toHaveBeenCalledWith(expect.stringContaining("tokens_weight_changed_upd"));
    expect(raw).toHaveBeenCalledWith(expect.stringContaining("tokens_weight_notify"));
    expect(raw).toHaveBeenCalledWith(expect.stringContaining("OLD.weight IS DISTINCT FROM NEW.weight"));
  });

  it("removes the versioned trigger before dropping the weight column", async () => {
    const { knex, raw } = fakeKnex();

    await down(knex);

    expect(raw).toHaveBeenCalledWith(expect.stringContaining("DROP TRIGGER"));
    expect(raw).toHaveBeenCalledWith(expect.stringContaining("tokens_weight_changed_upd"));
  });
});
