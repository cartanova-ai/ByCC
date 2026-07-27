import { getLogger } from "@logtape/logtape";
import { type FastifyReply } from "fastify";
import { isSoException } from "sonamu";

// statusCode 를 신뢰하는 범위를 Sonamu 예외 계약(isSoException)으로 한정한다. qgrid 는 프록시라
// upstream HTTP 오류(fetch/undici 류)도 statusCode 를 달고 나오는데, 그걸 duck-typing 으로
// 그대로 에코하면 upstream 의 401/429 가 호출자 자신의 오류로 둔갑한다. Sonamu 예외가 아니면 500.
export function handleServerError(error: Error, reply: FastifyReply): void {
  getLogger(["qgrid"]).error(`${error}`);
  const statusCode =
    isSoException(error) &&
    Number.isInteger(error.statusCode) &&
    error.statusCode >= 400 &&
    error.statusCode <= 599
      ? error.statusCode
      : 500;

  reply.status(statusCode).send({
    name: error.name,
    message: error.message,
  });
}
