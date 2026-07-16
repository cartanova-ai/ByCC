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

// 폴링에 편승하는 라이브 카운트 — 깊은 워커/큐 진단은 audit 대시보드(별도)의 몫이고,
// 여기는 "지금 몇 개 돌고 큐가 쌓이나"만 가볍게 답한다.
export const MonitVitals = z.object({
  openaiWorkerCount: z.number(),
  openaiReadyWorkerCount: z.number(),
  openaiQueueLength: z.number(),
  // 토큰별 현재 워커 수 — autoscale 로 늘고 주는 것을 토큰 단위로 본다
  openaiWorkersByToken: z.array(z.object({ name: z.string(), count: z.number() })),
  anthropicTokenCount: z.number(),
});
export type MonitVitals = z.infer<typeof MonitVitals>;

export const MonitLogChunk = z.object({
  processStartedAt: z.number(),
  entries: z.array(MonitLogEntry),
  nextCursor: z.number(),
  // 호출자의 커서가 buffer eviction 에 밀려 유실된 라인 수
  dropped: z.number(),
  vitals: MonitVitals,
});
export type MonitLogChunk = z.infer<typeof MonitLogChunk>;

// 프로세스 단위 정적 환경 정보 — 어느 서버/DB 를 보고 있는지 한눈에 확인하는 용도.
// 비밀값(DB 비밀번호, 토큰)은 절대 싣지 않는다.
export const MonitServerInfo = z.object({
  serverUrl: z.string(),
  dbHost: z.string(),
  dbName: z.string(),
  openai: z.object({
    minWorkersPerToken: z.number(),
    maxWorkersPerToken: z.number(),
    autoscale: z.boolean(),
  }),
});
export type MonitServerInfo = z.infer<typeof MonitServerInfo>;
