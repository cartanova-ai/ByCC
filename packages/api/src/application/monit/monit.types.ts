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

// 폴링에 편승하는 라이브 카운트 — 깊은 큐/토큰 진단은 audit 대시보드(별도)의 몫이고,
// 여기는 "지금 permit 이 얼마나 차 있고 큐가 쌓이나"만 가볍게 답한다.
export const MonitVitals = z.object({
  // 지금 나가 있는 동시 요청 수 — 상한 없음(Anthropic 과 동일한 stateless 실행 모델).
  // 토큰별 숫자는 노출하지 않는다: Anthropic 칩과 동일하게 이름 나열이 기본이고,
  // 토큰 단위로 의미 있는 상태는 쿼터 스냅샷이 맡는다.
  openaiInFlight: z.number(),
  // 토큰별 쿼터 스냅샷 — dispatcher 의 60초 rate-limits 캐시에서만 읽는다(비신선이면 null).
  // threshold 미설정 토큰은 쿼터 판정을 돌지 않아 usedPercent 가 계속 null 일 수 있다.
  openaiQuotaByToken: z.array(
    z.object({
      name: z.string(),
      usedPercent: z.number().nullable(),
      threshold: z.number().nullable(),
      blocked: z.boolean(),
      resetsAt: z.number().nullable(),
    }),
  ),
  anthropicTokenCount: z.number(),
  // fresh-spawn 이라 상주 프로세스가 없다 — 풀에 어떤 토큰이 있는지만 보여준다
  anthropicTokenNames: z.array(z.string()),
  // 지금 실행 중인 Claude Code 프로세스 수
  anthropicInFlight: z.number(),
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
  // permit/큐 제거 후 남은 정적 설정은 전송 방식뿐이다. 동시성 상한은 없다.
  openai: z.object({
    transport: z.string(),
  }),
});
export type MonitServerInfo = z.infer<typeof MonitServerInfo>;

// 최근 1시간 provider 별 요청 통계 — request_logs 를 집계한다. vitals 와 달리 DB 를
// 타므로 별도 endpoint 로 분리해 더 느슨한 주기로 폴링한다.
export const MonitProviderStats = z.object({
  provider: z.string(), // "openai" | "anthropic" | "unknown"
  requests: z.number(),
  errors: z.number(),
  inputTokens: z.number(),
  cacheReadTokens: z.number(),
});
export type MonitProviderStats = z.infer<typeof MonitProviderStats>;

export const MonitStats = z.object({
  windowMinutes: z.number(),
  providers: z.array(MonitProviderStats),
});
export type MonitStats = z.infer<typeof MonitStats>;
