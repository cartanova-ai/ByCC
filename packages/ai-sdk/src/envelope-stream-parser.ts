/**
 * 툴콜 봉투 증분 파서 (SON-527)
 *
 * 툴이 있는 요청에서 모델 원출력은 봉투 JSON 이다:
 *   { "result": { "action": "answer"|"tool_call", "answer": ..., "toolCalls": ... } }
 *
 * 서버는 이 봉투를 그대로 SSE delta 로 흘리므로, 클라이언트에서 증분 파싱해
 * `action:"answer"` 로 판명되는 순간부터 `answer` 값만 델타로 재방출한다.
 *
 * - action 미판명 구간: answer 조각을 내부 버퍼에 축적 (방출 없음).
 * - action = "answer": 버퍼 flush 후 실시간 방출.
 * - action = "tool_call": 버퍼 폐기, 이후 영구 침묵 — 기존 동작과 동일.
 *
 * answerKind 별 방출 형태:
 * - "text": answer 는 JSON 문자열 → 이스케이프 해제한 평문. 델타 경계에서
 *   잘린 `\uXXXX` 등도 문자 단위 상태 기계라 안전하다.
 * - "json": answer 값의 raw JSON 텍스트 verbatim → AI SDK partialOutputStream
 *   이 미완성 JSON 을 부분 파싱한다.
 *
 * 이 파서는 미리보기 방출 전용이다. 최종 정답은 서버 strict 디코더가
 * 결정하므로, 여기서 인식 불가한 입력을 만나면 그냥 침묵하면 된다 (done
 * 이벤트의 완성본 폴백이 커버).
 */

export type EnvelopeAnswerKind = "text" | "json";

export interface EnvelopeStreamParser {
  /** 델타 조각을 넣고, 지금 방출해도 되는 텍스트를 돌려받는다 (없으면 ""). */
  push(chunk: string): string;
}

const ESCAPE_MAP: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

// 토크나이저가 값 시작 문자로 인정하는 리터럴/숫자 문자.
const LITERAL_CHARS = /[0-9a-zA-Z+\-.eE]/;

export function createEnvelopeStreamParser(answerKind: EnvelopeAnswerKind): EnvelopeStreamParser {
  // ── 방출 제어 ──────────────────────────────────────────────
  let action: "answer" | "tool_call" | null = null;
  let discard = false; // tool_call 판명 또는 회복 불가 입력 → 영구 침묵
  let pending = ""; // action 미판명 동안 모아둔 answer 조각
  let out = ""; // 이번 push 에서 방출할 조각

  const emit = (text: string) => {
    if (discard || text === "") return;
    if (action === "answer") out += text;
    else pending += text;
  };

  const resolveAction = (value: string) => {
    if (action !== null) return;
    if (value === "answer") {
      action = "answer";
      out += pending;
      pending = "";
    } else {
      // tool_call 및 미지의 값 — 방출하지 않는 쪽으로 수렴한다.
      action = "tool_call";
      discard = true;
      pending = "";
    }
  };

  // ── 메인 토크나이저 상태 ──────────────────────────────────
  // frame: 컨테이너 진입 시의 key ("result" 등). 루트 object 는 null.
  const stack: Array<{ type: "object" | "array"; openedAtKey: string | null }> = [];
  // mode: 다음에 올 토큰 종류.
  let mode: "value" | "key" | "colon" | "afterValue" | "literal" = "value";
  let currentKey: string | null = null;

  // 문자열 파싱 상태 (key / 일반 value / action / answer-text 공용)
  let inString = false;
  let stringIsKey = false;
  let escape = false;
  let unicode: string | null = null; // \uXXXX 수집 버퍼
  let keyBuf = "";
  let actionBuf = "";

  // capture: 지금 파싱 중인 문자열/값이 무엇인지.
  let capture: "none" | "action" | "answer-text" = "none";

  // ── answer raw 캡처 상태 (answerKind: "json") ─────────────
  // 메인 토크나이저를 잠시 세우고 answer 값 전체를 verbatim 통과시킨다.
  let rawActive = false;
  let rawDepth = 0;
  let rawInString = false;
  let rawEscape = false;
  let rawIsLiteral = false;

  // 봉투 레벨(result 오브젝트 직속)의 값인지 판별.
  const atEnvelopeLevel = () =>
    stack.length === 2 && stack[0].openedAtKey === null && stack[1].openedAtKey === "result";

  const deliverStringChar = (ch: string) => {
    if (stringIsKey) keyBuf += ch;
    else if (capture === "action") actionBuf += ch;
    else if (capture === "answer-text") emit(ch);
  };

  const endString = () => {
    inString = false;
    if (stringIsKey) {
      currentKey = keyBuf;
      mode = "colon";
      return;
    }
    if (capture === "action") resolveAction(actionBuf);
    capture = "none";
    mode = "afterValue";
  };

  // raw 캡처 종료 후 메인 토크나이저 복귀. 리터럴 종료 문자는 재처리 필요.
  const endRaw = (reprocessChar?: string) => {
    rawActive = false;
    mode = "afterValue";
    if (reprocessChar !== undefined) step(reprocessChar);
  };

  const rawStep = (c: string) => {
    if (rawIsLiteral) {
      if (LITERAL_CHARS.test(c)) {
        // null/숫자 리터럴 — answer 가 null 인 경우 tool_call 변형이므로
        // 방출해봤자 pending 에서 폐기된다. 그래도 흘리지 않는 게 안전.
        return;
      }
      rawIsLiteral = false;
      endRaw(c);
      return;
    }
    emit(c);
    if (rawInString) {
      if (rawEscape) rawEscape = false;
      else if (c === "\\") rawEscape = true;
      else if (c === '"') {
        rawInString = false;
        if (rawDepth === 0) endRaw(); // answer 가 단일 문자열이었던 경우
      }
      return;
    }
    if (c === '"') rawInString = true;
    else if (c === "{" || c === "[") rawDepth++;
    else if (c === "}" || c === "]") {
      rawDepth--;
      if (rawDepth === 0) endRaw();
    }
  };

  const startValue = (c: string) => {
    const watchedAction = atEnvelopeLevel() && currentKey === "action";
    const watchedAnswer = atEnvelopeLevel() && currentKey === "answer";

    if (watchedAnswer && answerKind === "json") {
      // answer 값 전체를 raw 통과. 스칼라(문자열/null)도 대응한다.
      rawActive = true;
      rawDepth = 0;
      rawInString = false;
      rawEscape = false;
      rawIsLiteral = false;
      if (c === "{" || c === "[") {
        rawDepth = 1;
        emit(c);
      } else if (c === '"') {
        rawInString = true;
        emit(c);
      } else {
        rawIsLiteral = true; // null 등 — 방출 없이 소비
      }
      return;
    }

    if (c === '"') {
      inString = true;
      stringIsKey = false;
      escape = false;
      unicode = null;
      if (watchedAction) {
        capture = "action";
        actionBuf = "";
      } else if (watchedAnswer && answerKind === "text") {
        capture = "answer-text";
      } else {
        capture = "none";
      }
      return;
    }
    if (c === "{") {
      stack.push({ type: "object", openedAtKey: currentKey });
      currentKey = null;
      mode = "key";
      return;
    }
    if (c === "[") {
      stack.push({ type: "array", openedAtKey: currentKey });
      currentKey = null;
      mode = "value";
      return;
    }
    if (c === "]" && stack[stack.length - 1]?.type === "array") {
      // 빈 배열 []
      stack.pop();
      mode = "afterValue";
      return;
    }
    if (LITERAL_CHARS.test(c)) {
      mode = "literal";
      return;
    }
    // 인식 불가 입력 — 미리보기 포기 (done 폴백이 커버).
    discard = true;
  };

  const step = (c: string) => {
    if (discard) return;

    if (rawActive) {
      rawStep(c);
      return;
    }

    if (inString) {
      if (unicode !== null) {
        unicode += c;
        if (unicode.length === 4) {
          const code = Number.parseInt(unicode, 16);
          unicode = null;
          if (Number.isNaN(code)) {
            discard = true;
            return;
          }
          deliverStringChar(String.fromCharCode(code));
        }
        return;
      }
      if (escape) {
        escape = false;
        if (c === "u") {
          unicode = "";
          return;
        }
        const mapped = ESCAPE_MAP[c];
        if (mapped === undefined) {
          discard = true;
          return;
        }
        deliverStringChar(mapped);
        return;
      }
      if (c === "\\") {
        escape = true;
        return;
      }
      if (c === '"') {
        endString();
        return;
      }
      deliverStringChar(c);
      return;
    }

    if (mode === "literal") {
      if (LITERAL_CHARS.test(c)) return;
      mode = "afterValue";
      step(c);
      return;
    }

    if (c === " " || c === "\t" || c === "\n" || c === "\r") return;

    switch (mode) {
      case "value":
        startValue(c);
        return;
      case "key":
        if (c === '"') {
          inString = true;
          stringIsKey = true;
          escape = false;
          unicode = null;
          keyBuf = "";
        } else if (c === "}") {
          stack.pop();
          mode = "afterValue";
        } else {
          discard = true;
        }
        return;
      case "colon":
        if (c === ":") {
          mode = "value";
          stringIsKey = false;
        } else {
          discard = true;
        }
        return;
      case "afterValue":
        if (c === ",") {
          const frame = stack[stack.length - 1];
          if (!frame) {
            discard = true;
            return;
          }
          currentKey = null;
          mode = frame.type === "object" ? "key" : "value";
        } else if (c === "}" || c === "]") {
          stack.pop();
          // 문서 종료 후 잔여 문자는 무시한다 (서버 디코더가 최종 판정).
        } else {
          discard = true;
        }
        return;
    }
  };

  return {
    push(chunk: string): string {
      if (discard) return "";
      for (const c of chunk) {
        step(c);
        if (discard) break;
      }
      const emitted = out;
      out = "";
      return emitted;
    },
  };
}
