import { describe, expect, it } from "vitest";

import { createFenceStripTransform, stripFences } from "./fence-strip";

// 스트림 절단 지점에 무관하게 "방출 연결 + flush == stripFences(전체)" 가 성립해야 한다.
function runAllSplits(full: string): void {
  const expected = stripFences(full);
  for (let i = 0; i <= full.length; i += 1) {
    for (let j = i; j <= full.length; j += 1) {
      const t = createFenceStripTransform();
      const out =
        t.push(full.slice(0, i)) + t.push(full.slice(i, j)) + t.push(full.slice(j)) + t.flush();
      expect(out, `split at ${i},${j}`).toBe(expected);
    }
  }
}

describe("stripFences", () => {
  it("펜스 없음 — 양끝 공백만 제거하고 원문 유지 (1091748 케이스)", () => {
    expect(stripFences('{"a":1}')).toBe('{"a":1}');
    expect(stripFences('  {"a":1}\n')).toBe('{"a":1}');
  });

  it("json 태그 펜스를 벗긴다", () => {
    expect(stripFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("언어 태그 없는 펜스를 벗긴다", () => {
    expect(stripFences('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("선두 공백/개행 + 펜스 조합", () => {
    expect(stripFences('\n\n  ```json\n{"a":1}\n```  \n')).toBe('{"a":1}');
  });

  it("JSON 문자열 값 내부의 백틱은 건드리지 않는다", () => {
    const inner = '{"code":"```json\\n{}\\n```ok"}';
    expect(stripFences(inner)).toBe(inner);
  });

  it("펜스만 있고 본문 없음 → 빈 문자열", () => {
    expect(stripFences("```json\n```")).toBe("");
  });
});

describe("createFenceStripTransform", () => {
  it("여는 펜스가 delta 경계에 걸쳐 도착해도 본문만 방출한다", () => {
    const t = createFenceStripTransform();
    let out = t.push("``");
    out += t.push("`js");
    out += t.push('on\n{"a"');
    out += t.push(":1}\n``");
    out += t.push("`");
    out += t.flush();
    expect(out).toBe('{"a":1}');
  });

  it("닫는 펜스 직전까지 방출되고 tail 홀드백이 펜스를 삼킨다", () => {
    const t = createFenceStripTransform();
    const first = t.push('```json\n{"a":1}');
    // 본문은 도착 즉시 흘러야 한다 (닫는 펜스 후보가 아니므로)
    expect(first).toBe('{"a":1}');
    expect(t.push("\n```") + t.flush()).toBe("");
  });

  it("홀드백 후보였으나 펜스가 아니면 내용 무손실로 방출한다", () => {
    const t = createFenceStripTransform();
    const out = t.push('{"a":"x') + t.push("``") + t.push('y"}') + t.flush();
    expect(out).toBe('{"a":"x``y"}');
  });

  it("닫는 펜스 앞의 긴 공백 런도 전부 보류 후 폐기한다", () => {
    const gap = "\n".repeat(4_000) + " ".repeat(4_000);
    const t = createFenceStripTransform();
    const out = t.push('```json\n{"a":1}') + t.push(gap) + t.push("\n```") + t.flush();
    // 전체 연산과 동일해야 한다: trim 이 trailing 공백을 지우고 펜스가 벗겨진다
    expect(out).toBe(stripFences('```json\n{"a":1}' + gap + "\n```"));
  });

  it("미완성 펜스로 끝나는 스트림은 그 백틱을 방출한다 (닫는 펜스 아님)", () => {
    const t = createFenceStripTransform();
    const out = t.push('{"a":1}\n``') + t.flush();
    expect(out).toBe('{"a":1}\n``');
  });

  it("본문 뒤 공백만으로 끝나면 trailing 공백 제거만 적용된다", () => {
    const t = createFenceStripTransform();
    const out = t.push('{"a":1}') + t.push("  \n\n") + t.flush();
    expect(out).toBe('{"a":1}');
  });

  it("불변식: 임의 절단 지점에서 방출 연결 == stripFences(전체)", () => {
    const samples = [
      '{"a":1}',
      '```json\n{"a":1}\n```',
      '```JSON\n{"a":1}\n```',
      '```\n{"a":1}\n```',
      '  \n```json  \n\n{"a":[1,2]}\n\n```  ',
      '{"code":"```"}',
      "```json\n```",
      "``",
      "```jsx\n{}\n```",
      '{"a":1}\n``` extra',
      '{"a":1}``````',
      "   \n  ",
      "",
      '```json{"inline":true}```',
    ];
    for (const sample of samples) runAllSplits(sample);
  });

  it("불변식: 유니코드 공백(NBSP·VT·FF·LS·PS·BOM)에서도 성립 (2차 검토 #8)", () => {
    // trim() 이 지우는 비 ASCII 공백이 tail 에 있으면 홀드백이 함께 보류해야 한다
    const ws = [" ", "\v", "\f", " ", " ", "﻿"];
    for (const w of ws) {
      runAllSplits(`{"a":1}${w}`);
      runAllSplits(`${w}{"a":1}${w}${w}`);
      runAllSplits(`\`\`\`json\n{"a":1}\n\`\`\`${w}`);
      runAllSplits(`{"a":1}${w}\n\`\`\``);
    }
  });
});
