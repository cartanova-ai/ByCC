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

  // ── 엣지케이스 보강 ──────────────────────────────────────────
  describe("edge cases", () => {
    const textEnvelope = (answer: string) =>
      `{"result":{"action":"answer","answer":${JSON.stringify(answer)},"toolCalls":null}}`;

    /** 시드 고정 LCG — 재현 가능한 랜덤 청크 분할. */
    function chunkBySeed(s: string, seed: number): string[] {
      let state = seed >>> 0;
      const next = () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 2 ** 32;
      };
      const chunks: string[] = [];
      let i = 0;
      while (i < s.length) {
        const len = 1 + Math.floor(next() * 7);
        chunks.push(s.slice(i, i + len));
        i += len;
      }
      return chunks;
    }

    it("survives 100 seeded random chunkings (text kind)", () => {
      const answer = '멀티라인\n"인용"과 \\경로\\ 이모지 \u{1F600}\u{1F680} 탭\t끝';
      const envelope = textEnvelope(answer);
      for (let seed = 1; seed <= 100; seed++) {
        expect(pushAll("text", chunkBySeed(envelope, seed)), `seed ${seed}`).toBe(answer);
      }
    });

    it("survives 100 seeded random chunkings (json kind, deep nesting)", () => {
      const answerObj = {
        episodes: [
          { id: 1333, title: '도현의 "일본" 편', tags: ["여행", "{중괄호}", "]}깨짐유도"] },
          { id: 7, nested: { a: [1, [2, [3, { b: 'x\\y"z' }]]] } },
        ],
        note: "escape \n test \u{1F600}",
      };
      const rawAnswer = JSON.stringify(answerObj);
      const envelope = `{"result":{"action":"answer","answer":${rawAnswer},"toolCalls":null}}`;
      for (let seed = 1; seed <= 100; seed++) {
        const emitted = pushAll("json", chunkBySeed(envelope, seed));
        expect(emitted, `seed ${seed}`).toBe(rawAnswer);
        expect(JSON.parse(emitted)).toEqual(answerObj);
      }
    });

    it("handles a raw astral char split between surrogate halves across pushes", () => {
      const envelope = textEnvelope("a\u{1F600}b");
      const splitAt = envelope.indexOf("\u{1F600}") + 1; // high/low 서로게이트 사이
      const emitted = pushAll("text", [envelope.slice(0, splitAt), envelope.slice(splitAt)]);
      expect(emitted).toBe("a\u{1F600}b");
    });

    it("unescapes every control escape and solidus", () => {
      const answer = "b\b f\f n\n r\r t\t slash/ quote\" back\\";
      expectSplitInvariant("text", textEnvelope(answer), answer);
    });

    it("emits nothing for an empty answer string, falling back to done", () => {
      expectSplitInvariant("text", textEnvelope(""), "");
    });

    it("tolerates unknown extra keys around action and answer", () => {
      const env =
        '{"result":{"reasoning":"생각 {중} 이다","action":"answer","confidence":0.9,"answer":"ok","toolCalls":null,"extra":[1,2]}}';
      expectSplitInvariant("text", env, "ok");
    });

    it("is unaffected by trailing garbage after the envelope closes", () => {
      const env = `${textEnvelope("clean")}<|proto_end|>{"action":"fake"}`;
      expectSplitInvariant("text", env, "clean");
    });

    it("emits the streamed prefix without throwing when the stream dies mid-answer", () => {
      const parser = createEnvelopeStreamParser("text");
      expect(parser.push('{"result":{"action":"answer","answer":"부분 답')).toBe("부분 답");
      // 이후 done 폴백은 doStream 레이어의 몫 — 파서는 조용히 끝난다.
      expect(parser.push("")).toBe("");
    });

    it("stays silent when a text preamble precedes the envelope (fallback covers)", () => {
      const chunks = ["Let me look that up. ", '{"result":{"action":"answer","answer":"x"}}'];
      expect(pushAll("text", chunks)).toBe("");
    });

    it("stays silent on a BOM-prefixed document", () => {
      expect(pushAll("text", ["\uFEFF" + textEnvelope("x")])).toBe("");
    });

    it("does not leak an object answer when answerKind is text (schema violation input)", () => {
      const env = '{"result":{"action":"answer","answer":{"oops":"obj"},"toolCalls":null}}';
      expectSplitInvariant("text", env, "");
    });

    it("passes a bare string answer through verbatim when answerKind is json", () => {
      const env = '{"result":{"action":"answer","answer":"plain \\"str\\"","toolCalls":null}}';
      expectSplitInvariant("json", env, '"plain \\"str\\""');
    });

    it("keeps first action resolution on duplicate action keys (tool_call wins, stays silent)", () => {
      const env =
        '{"result":{"action":"tool_call","action":"answer","answer":"late","toolCalls":null}}';
      expectSplitInvariant("text", env, "");
    });

    it("keeps first action resolution on duplicate action keys (answer wins, keeps emitting)", () => {
      const env =
        '{"result":{"action":"answer","answer":"early","action":"tool_call","toolCalls":null}}';
      expectSplitInvariant("text", env, "early");
    });

    it("returns empty for pushes after the document completed", () => {
      const parser = createEnvelopeStreamParser("text");
      parser.push(textEnvelope("done"));
      expect(parser.push('{"result":{"action":"answer","answer":"again"}}')).toBe("");
    });

    it("is a no-op for empty-string pushes at any point", () => {
      const parser = createEnvelopeStreamParser("text");
      expect(parser.push("")).toBe("");
      expect(parser.push('{"result":{"action":"answer","answer":"a')).toBe("a");
      expect(parser.push("")).toBe("");
      expect(parser.push('b"}}')).toBe("b");
    });

    it("handles CRLF and exotic whitespace between tokens", () => {
      const env =
        '{\r\n\t"result"\r\n:\t{\r\n"action"\t:\r\n"answer",\r\n"answer":\t"ok",\r\n"toolCalls":null}\r\n}';
      expectSplitInvariant("text", env, "ok");
    });

    it("keeps depth tracking safe with brace-noise inside tool_call args (stays silent)", () => {
      const env =
        '{"result":{"action":"tool_call","answer":null,"toolCalls":[{"toolName":"t","args":"{\\"q\\":\\"}}]]{{[[\\"}"}]}}';
      expectSplitInvariant("json", env, "");
      expectSplitInvariant("text", env, "");
    });
  });
});
