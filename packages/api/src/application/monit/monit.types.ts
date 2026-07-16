import { z } from "zod";

// ─── Monit (프로세스 로그 관측) ───
//
// timestamp/processStartedAt 은 epoch ms 숫자다. web 전역 dateReviver 가 ISO 문자열을
// Date 로 변환하므로, 숫자만이 재시작 감지(processStartedAt 동등성)와 커서 비교를 보존한다.
// 이 파일은 web 으로 그대로 sync 되므로 서버 전용 import 를 두지 않는다.

export const MonitLogEntry = z.object({
  seq: z.number(),
  timestamp: z.number(),
  level: z.string(),
  category: z.array(z.string()),
  text: z.string(),
});
export type MonitLogEntry = z.infer<typeof MonitLogEntry>;

export const MonitLogChunk = z.object({
  processStartedAt: z.number(),
  entries: z.array(MonitLogEntry),
  nextCursor: z.number(),
  // 호출자의 커서가 buffer eviction 에 밀려 유실된 라인 수
  dropped: z.number(),
});
export type MonitLogChunk = z.infer<typeof MonitLogChunk>;
