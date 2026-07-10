import { describe, expect, it, vi } from "vitest";

import { bootstrapServer } from "./server-bootstrap";

describe("server bootstrap", () => {
  it("finishes required migrations before binding the server socket", async () => {
    const calls: string[] = [];
    const init = vi.fn(async () => {
      calls.push("init");
    });
    const migrate = vi.fn(async () => {
      calls.push("migrate");
    });
    const listen = vi.fn(async () => {
      calls.push("listen");
    });

    await bootstrapServer({ init, migrate, listen });

    expect(calls).toEqual(["init", "migrate", "listen"]);
  });

  it("does not bind the socket when a required migration fails", async () => {
    const failure = new Error("migration failed");
    const listen = vi.fn();

    await expect(
      bootstrapServer({
        init: vi.fn(async () => {}),
        migrate: vi.fn(async () => {
          throw failure;
        }),
        listen,
      }),
    ).rejects.toBe(failure);

    expect(listen).not.toHaveBeenCalled();
  });
});
