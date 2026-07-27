import { BadRequestException } from "sonamu";
import { describe, expect, it, vi } from "vitest";

import { handleServerError } from "./server-error-handler";

function createReply() {
  const send = vi.fn();
  const status = vi.fn(() => ({ send }));
  return { reply: { status } as never, send, status };
}

describe("handleServerError", () => {
  it("preserves explicit client error status codes", () => {
    const { reply, send, status } = createReply();
    const error = new BadRequestException("invalid schema" as never);

    handleServerError(error, reply);

    expect(status).toHaveBeenCalledWith(400);
    expect(send).toHaveBeenCalledWith({
      name: error.name,
      message: "invalid schema",
    });
  });

  it.each([
    ["ordinary errors", new Error("provider failed")],
    ["invalid success-like status codes", Object.assign(new Error("wrong status"), { statusCode: 200 })],
    ["out-of-range status codes", Object.assign(new Error("wrong status"), { statusCode: 700 })],
  ])("keeps %s as internal server errors", (_label, error) => {
    const { reply, status } = createReply();

    handleServerError(error, reply);

    expect(status).toHaveBeenCalledWith(500);
  });
});
