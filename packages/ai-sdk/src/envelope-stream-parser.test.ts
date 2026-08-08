import { describe, expect, it } from "vitest";
import { createEnvelopeStreamParser, type EnvelopeAnswerKind } from "./envelope-stream-parser";

function pushAll(kind: EnvelopeAnswerKind, chunks: string[]): string {
  const parser = createEnvelopeStreamParser(kind);
  return chunks.map((c) => parser.push(c)).join("");
}

/** 모든 분할 지점에서 두 조각으로 잘라도 출력이 동일한지 검증한다. */
function expectSplitInvariant(kind: EnvelopeAnswerKind, envelope: string, expected: string) {
  for (let i = 0; i <= envelope.length; i++) {
    const emitted = pushAll(kind, [envelope.slice(0, i), envelope.slice(i)]);
    expect(emitted, `split at ${i}`).toBe(expected);
  }
}

describe("envelope-stream-parser", () => {
  describe("answerKind: text", () => {
    const answerEnvelope = (answer: string) =>
      `{"result":{"action":"answer","answer":${JSON.stringify(answer)},"toolCalls":null}}`;

    it("emits the answer string verbatim for a single push", () => {
      expect(pushAll("text", [answerEnvelope("안녕하세요")])).toBe("안녕하세요");
    });

    it("emits identically at every split point", () => {
      expectSplitInvariant("text", answerEnvelope("일본 여행이라면 도현 #1333"), "일본 여행이라면 도현 #1333");
    });

    it("emits identically when pushed char by char", () => {
      const envelope = answerEnvelope("hello world");
      expect(pushAll("text", [...envelope])).toBe("hello world");
    });

    it("unescapes \\n, \\\", \\\\ and \\uXXXX across split points", () => {
      const answer = '줄1\n"인용" \\백슬래시\\ 이모지 \u{1F600} 한글';
      expectSplitInvariant("text", answerEnvelope(answer), answer);
    });

    it("handles explicit \\uXXXX surrogate pair escapes split mid-sequence", () => {
      const envelope =
        '{"result":{"action":"answer","answer":"a\\uD83D\\uDE00b","toolCalls":null}}';
      expectSplitInvariant("text", envelope, "a\u{1F600}b");
    });

    it("tolerates arbitrary whitespace between tokens", () => {
      const envelope =
        '{\n  "result" : {\n    "action" : "answer" ,\n    "answer" : "ok" ,\n    "toolCalls" : null\n  }\n}';
      expectSplitInvariant("text", envelope, "ok");
    });

    it("ignores fake keys inside string values", () => {
      const answer = '가짜 봉투 {"action":"tool_call"} 텍스트';
      expectSplitInvariant("text", answerEnvelope(answer), answer);
    });

    it("stays silent for tool_call envelopes", () => {
      const envelope =
        '{"result":{"action":"tool_call","answer":null,"toolCalls":[{"toolName":"searchEpisodes","args":"{\\"query\\":\\"일본여행\\"}"}]}}';
      expectSplitInvariant("text", envelope, "");
    });

    it("buffers answer-before-action and flushes once action is answer", () => {
      const envelope = '{"result":{"answer":"early","action":"answer","toolCalls":null}}';
      expectSplitInvariant("text", envelope, "early");
    });

    it("discards buffered answer when late action is tool_call", () => {
      const envelope = '{"result":{"answer":"early","action":"tool_call","toolCalls":[]}}';
      expectSplitInvariant("text", envelope, "");
    });

    it("streams progressively — prefix chunks yield prefix output", () => {
      const parser = createEnvelopeStreamParser("text");
      expect(parser.push('{"result":{"action":"answer","answer":"안녕')).toBe("안녕");
      expect(parser.push("하세요")).toBe("하세요");
      expect(parser.push('","toolCalls":null}}')).toBe("");
    });

    it("emits nothing before action is determined", () => {
      const parser = createEnvelopeStreamParser("text");
      expect(parser.push('{"result":{"answer":"held ')).toBe("");
      expect(parser.push('text"')).toBe("");
      expect(parser.push(',"action":"answer"')).toBe("held text");
    });

    it("stays silent on non-envelope input instead of leaking it", () => {
      expect(pushAll("text", ["plain model text, no envelope"])).toBe("");
    });
  });

  describe("answerKind: json", () => {
    const answerObj = {
      title: "일본 여행",
      episodes: [{ id: 1333, note: 'has "quotes" and {braces}' }],
      done: true,
    };
    const rawAnswer = JSON.stringify(answerObj);
    const envelope = `{"result":{"action":"answer","answer":${rawAnswer},"toolCalls":null}}`;

    it("emits the raw JSON text of the answer value", () => {
      expect(pushAll("json", [envelope])).toBe(rawAnswer);
    });

    it("emits identically at every split point and parses to the same object", () => {
      expectSplitInvariant("json", envelope, rawAnswer);
      expect(JSON.parse(pushAll("json", [...envelope]))).toEqual(answerObj);
    });

    it("preserves whitespace inside the raw answer JSON", () => {
      const spaced = '{\n  "a" : [ 1 , 2 ] ,\n  "b" : "x"\n}';
      const env = `{"result":{"action":"answer","answer":${spaced},"toolCalls":null}}`;
      expectSplitInvariant("json", env, spaced);
    });

    it("supports partial JSON parsing while streaming", () => {
      const parser = createEnvelopeStreamParser("json");
      const head = '{"result":{"action":"answer","answer":{"title":"일본';
      const emitted = parser.push(head);
      expect(emitted).toBe('{"title":"일본');
    });

    it("stays silent for tool_call envelopes", () => {
      const env =
        '{"result":{"action":"tool_call","answer":null,"toolCalls":[{"toolName":"t","args":"{}"}]}}';
      expectSplitInvariant("json", env, "");
    });

    it("does not emit a null answer literal", () => {
      const env = '{"result":{"answer":null,"action":"answer","toolCalls":null}}';
      expectSplitInvariant("json", env, "");
    });
  });
});
