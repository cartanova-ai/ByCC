import { type FastifyReply } from "fastify";
import {
  BadRequestException,
  InternalServerErrorException,
  ServiceUnavailableException,
} from "sonamu";
import { describe, expect, it, vi } from "vitest";

import { handleServerError } from "./server-error-handler";

function fakeReply() {
  const reply = {
    header: vi.fn(),
    status: vi.fn(),
    send: vi.fn(),
  };
  reply.status.mockReturnValue(reply);
  return reply as unknown as FastifyReply & typeof reply;
}

describe("handleServerError", () => {
  it("Sonamu 예외의 statusCode 를 그대로 쓴다", () => {
    const reply = fakeReply();

    handleServerError(new BadRequestException("bad" as never), reply);

    expect(reply.status).toHaveBeenCalledWith(400);
  });

  it("Sonamu 예외가 아니면 statusCode 를 신뢰하지 않고 500 으로 내린다", () => {
    const reply = fakeReply();
    // upstream fetch 오류처럼 statusCode 를 달고 오는 예외 — 그대로 에코하면 upstream 의
    // 401 이 호출자 자신의 오류로 둔갑한다.
    const upstream = Object.assign(new Error("upstream said 401"), { statusCode: 401 });

    handleServerError(upstream, reply);

    expect(reply.status).toHaveBeenCalledWith(500);
  });

  it("503 에는 Retry-After 를 붙여 재시도 시점을 알린다", () => {
    const reply = fakeReply();

    handleServerError(new ServiceUnavailableException("starting up" as never), reply);

    expect(reply.status).toHaveBeenCalledWith(503);
    expect(reply.header).toHaveBeenCalledWith("Retry-After", expect.any(String));
  });

  it("503 이 아닌 응답에는 Retry-After 를 붙이지 않는다", () => {
    const reply = fakeReply();

    handleServerError(new InternalServerErrorException("dead" as never), reply);

    expect(reply.status).toHaveBeenCalledWith(500);
    expect(reply.header).not.toHaveBeenCalled();
  });
});
