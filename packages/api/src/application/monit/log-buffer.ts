/**
 * Monit 로그 ring buffer — 프로세스 생존 기간 동안 최근 로그를 구조화 레코드로 보관한다.
 *
 * 콘솔 sink 와 병렬로 등록되는 두 번째 logtape sink 가 이 버퍼를 채우고,
 * monit.frame 이 커서 기반으로 읽어 대시보드 Monit 탭에 제공한다.
 * 재시작하면 리셋된다 — 영속 기록은 request_log 의 몫.
 *
 * timestamp/processStartedAt 은 epoch ms 숫자로 유지한다. web 의 전역 dateReviver 가
 * ISO 문자열을 Date 로 바꿔버리므로, 숫자만이 재시작 감지의 동등성 비교를 보존한다.
 */
import { type LogRecord, type Sink } from "@logtape/logtape";

const DEFAULT_CAPACITY = 2_000;
const DEFAULT_MAX_TEXT_LENGTH = 4_000;

// 표시 전용 wire 레코드. properties/원본 값은 버퍼에 싣지 않는다(allowlist).
export interface MonitLogEntry {
  seq: number;
  timestamp: number;
  level: string;
  category: string[];
  text: string;
}

export interface MonitLogChunk {
  entries: MonitLogEntry[];
  nextCursor: number;
  // 호출자의 커서가 eviction 에 밀려 유실된 라인 수. 0 이면 공백 없음.
  dropped: number;
}

// logtape message 배열은 홀수 길이 — 짝수 인덱스가 템플릿 텍스트, 홀수가 보간 값.
function flattenMessage(message: readonly unknown[]): string {
  return message
    .map((part, index) => (index % 2 === 0 ? String(part ?? "") : renderValue(part)))
    .join("");
}

function renderValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export class MonitLogBuffer {
  readonly processStartedAt = Date.now();
  private entries: MonitLogEntry[] = [];
  private nextSeq = 1;

  constructor(
    private readonly capacity = DEFAULT_CAPACITY,
    private readonly maxTextLength = DEFAULT_MAX_TEXT_LENGTH,
  ) {}

  // logtape sink 본체. logtape 가 sink 오류를 격리하지만, 버퍼 버그가
  // meta logger 소음을 만들지 않도록 방어적으로 한 번 더 감싼다.
  push(record: LogRecord): void {
    try {
      let text = flattenMessage(record.message);
      if (text.length > this.maxTextLength) {
        text = `${text.slice(0, this.maxTextLength)}…`;
      }
      this.entries.push({
        seq: this.nextSeq++,
        timestamp: record.timestamp,
        level: record.level,
        category: [...record.category],
        text,
      });
      if (this.entries.length > this.capacity) {
        this.entries.splice(0, this.entries.length - this.capacity);
      }
    } catch {
      // 로그 캡처 실패는 조용히 무시 — 로깅 경로를 절대 방해하지 않는다.
    }
  }

  get oldestSeq(): number {
    return this.entries[0]?.seq ?? this.nextSeq;
  }

  get latestSeq(): number {
    return this.nextSeq - 1;
  }

  // cursor 이후의 엔트리를 최대 limit 개 반환한다. cursor 미지정이면 tail.
  after(cursor: number | undefined, limit: number): MonitLogChunk {
    if (cursor === undefined) {
      const entries = this.entries.slice(-limit);
      return {
        entries,
        nextCursor: entries.at(-1)?.seq ?? this.latestSeq,
        dropped: 0,
      };
    }

    // 이전 프로세스의 커서 등 미래 커서는 방어적으로 현재 tail 로 재동기화한다.
    if (cursor > this.latestSeq) {
      return { entries: [], nextCursor: this.latestSeq, dropped: 0 };
    }

    const dropped = Math.max(this.oldestSeq - cursor - 1, 0);
    const startIndex = this.entries.findIndex((entry) => entry.seq > cursor);
    const entries = startIndex === -1 ? [] : this.entries.slice(startIndex, startIndex + limit);
    return {
      entries,
      nextCursor: entries.at(-1)?.seq ?? cursor + dropped,
      dropped,
    };
  }
}

export const monitLogBuffer = new MonitLogBuffer();

export const monitLogSink: Sink = (record) => {
  monitLogBuffer.push(record);
};
