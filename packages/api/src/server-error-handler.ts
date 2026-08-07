import { getLogger } from "@logtape/logtape";
import { type FastifyReply } from "fastify";
import { SoException } from "sonamu";

// dispatcher 기동은 dev0 기준 1~2분 걸린다(워커 25개 × spawn 간격). 그보다 짧게 잡으면
// 재시도가 같은 503 을 다시 받는다.
const RETRY_AFTER_SECONDS = "30";

// statusCode 를 신뢰하는 범위를 Sonamu 예외로 한정한다. qgrid 는 프록시라 upstream HTTP
// 오류(fetch/undici 류)도 statusCode 를 달고 나오는데, 그걸 그대로 에코하면 upstream 의
// 401/429 가 호출자 자신의 오류로 둔갑한다. Sonamu 예외가 아니면 500.
//
// sonamu 의 isSoException 은 `statusCode !== undefined` 만 보는 duck-typing 이라 바로 그
// upstream 예외를 통과시킨다. 여기서는 instanceof 로 실제 계약을 확인한다.
export function handleServerError(error: Error, reply: FastifyReply): void {
  getLogger(["qgrid"]).error(`${error}`);
  const statusCode =
    error instanceof SoException &&
    Number.isInteger(error.statusCode) &&
    error.statusCode >= 400 &&
    error.statusCode <= 599
      ? error.statusCode
      : 500;

  // 503 은 "지금은 아니지만 곧 된다"는 뜻이라 재시도 시점을 함께 준다. 값이 없으면
  // 클라이언트는 재시도 간격을 스스로 정해야 하고, 대개 즉시 재시도해 부하만 키운다.
  if (statusCode === 503) reply.header("Retry-After", RETRY_AFTER_SECONDS);

  reply.status(statusCode).send({
    name: error.name,
    message: error.message,
  });
}
