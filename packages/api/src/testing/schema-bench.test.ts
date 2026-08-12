import { describe, expect, it } from "vitest";

import {
  aggregateBench,
  type BenchRecord,
  checkpointKey,
  classifyBenchText,
  formatAggregateTable,
  parseCheckpointLines,
} from "./schema-bench";

describe("classifyBenchText — 3계층 배타 분류", () => {
  const opts = {
    requiredTopLevelKeys: ["title"],
    allowedTopLevelKeys: ["title", "mood"],
  };

  it("정상 응답은 syntax/contract ok, 위반 없음", () => {
    const c = classifyBenchText('{"title":"밤의 극장","mood":null}', opts);
    expect(c).toMatchObject({
      syntax: "ok",
      contract: "ok",
      topLevel: { wrapperKey: false, fenceResidue: false, prose: false },
    });
  });

  it("JSON 문법 실패는 syntax 계층에만 잡히고 contract 는 n/a", () => {
    const c = classifyBenchText('{"title": broken', opts);
    expect(c.syntax).toBe("fail");
    expect(c.contract).toBe("n/a");
  });

  it("필드 누락은 contract 계층에만 집계된다 (top-level 축 아님)", () => {
    const c = classifyBenchText('{"mood":"tense"}', opts);
    expect(c.syntax).toBe("ok");
    expect(c.contract).toBe("fail");
    expect(c.contractDetail).toContain("title");
    expect(c.topLevel.wrapperKey).toBe(false);
  });

  it("래퍼 키 병리(GEN-359)를 top-level 축으로 분류한다", () => {
    const c = classifyBenchText('{"$PARAMETER_NAME":{"title":"x"}}', opts);
    expect(c.syntax).toBe("ok");
    expect(c.contract).toBe("fail"); // required 누락이기도 하다
    expect(c.topLevel.wrapperKey).toBe(true);
  });

  it("펜스 잔존과 프로즈를 구분한다", () => {
    const fenced = classifyBenchText('```json\n{"title":"x"}\n```', opts);
    expect(fenced.syntax).toBe("fail");
    expect(fenced.topLevel.fenceResidue).toBe(true);
    expect(fenced.topLevel.prose).toBe(false);

    const prose = classifyBenchText("Sure! Here is the JSON you asked for.", opts);
    expect(prose.topLevel.prose).toBe(true);
    expect(prose.topLevel.fenceResidue).toBe(false);
  });

  it("fixture validate 실패는 contract fail 로 집계된다", () => {
    const c = classifyBenchText('{"title":"x"}', {
      ...opts,
      validate: (parsed) =>
        (parsed as { title: string }).title.length < 2 ? "title too short" : undefined,
    });
    expect(c.contract).toBe("fail");
    expect(c.contractDetail).toBe("title too short");
  });

  it("허용 키 목록이 없으면 래퍼 키 판정을 하지 않는다", () => {
    const c = classifyBenchText('{"anything":{"nested":1}}', {});
    expect(c.topLevel.wrapperKey).toBe(false);
    expect(c.contract).toBe("ok");
  });
});

describe("checkpoint", () => {
  const record: BenchRecord = {
    fixture: "schema-small",
    model: "anthropic/claude-sonnet-4-6",
    mode: "generate",
    iteration: 3,
    durationMs: 1200,
  };

  it("동일 조합은 같은 키 — resume 시 재발사가 스킵된다", () => {
    expect(checkpointKey(record)).toBe(checkpointKey({ ...record, durationMs: 99 }));
    expect(checkpointKey(record)).not.toBe(checkpointKey({ ...record, iteration: 4 }));
    expect(checkpointKey(record)).not.toBe(checkpointKey({ ...record, mode: "stream" }));
  });

  it("JSONL 을 파싱하고 부분 기록된 깨진 줄은 건너뛴다", () => {
    const jsonl = [
      JSON.stringify(record),
      JSON.stringify({ ...record, iteration: 4 }),
      '{"fixture":"schema-small","model":"an', // 중단으로 잘린 마지막 줄
    ].join("\n");

    const map = parseCheckpointLines(jsonl);
    expect(map.size).toBe(2);
    expect(map.has(checkpointKey(record))).toBe(true);
  });
});

describe("aggregateBench", () => {
  function rec(overrides: Partial<BenchRecord>): BenchRecord {
    return {
      fixture: "schema-small",
      model: "m",
      mode: "generate",
      iteration: 0,
      durationMs: 100,
      classification: {
        syntax: "ok",
        contract: "ok",
        topLevel: { wrapperKey: false, fenceResidue: false, prose: false },
      },
      ...overrides,
    };
  }

  it("전송 오류를 분모에 포함해 통과율을 계산한다", () => {
    const rows = aggregateBench([
      rec({ iteration: 0 }),
      rec({ iteration: 1 }),
      rec({ iteration: 2, transportError: "socket hang up", classification: undefined }),
      rec({
        iteration: 3,
        classification: {
          syntax: "fail",
          contract: "n/a",
          topLevel: { wrapperKey: false, fenceResidue: true, prose: false },
        },
      }),
    ]);

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.total).toBe(4);
    expect(row.passes).toBe(2);
    expect(row.passRate).toBe(0.5);
    expect(row.transportErrors).toBe(1);
    expect(row.syntaxFails).toBe(1);
    expect(row.fenceResidue).toBe(1);
  });

  it("모델×fixture×mode 로 그룹화한다", () => {
    const rows = aggregateBench([
      rec({ model: "a" }),
      rec({ model: "a", mode: "stream" }),
      rec({ model: "b" }),
    ]);
    expect(rows).toHaveLength(3);
  });

  it("duration 평균과 토큰·비용 합계를 낸다", () => {
    const rows = aggregateBench([
      rec({ iteration: 0, durationMs: 100, outputTokens: 10, costUsd: 0.01 }),
      rec({ iteration: 1, durationMs: 300, outputTokens: 20, costUsd: 0.02 }),
    ]);
    expect(rows[0]).toMatchObject({
      avgDurationMs: 200,
      totalOutputTokens: 30,
    });
    expect(rows[0]!.totalCostUsd).toBeCloseTo(0.03);
  });

  it("델타≠done 불일치를 집계한다", () => {
    const rows = aggregateBench([rec({ deltaDoneMismatch: true }), rec({ iteration: 1 })]);
    expect(rows[0]!.deltaDoneMismatches).toBe(1);
  });

  it("표 렌더가 헤더+행 형태를 유지한다", () => {
    const table = formatAggregateTable(aggregateBench([rec({})]));
    const lines = table.split("\n");
    expect(lines[0]).toContain("rate");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("100.0%");
  });
});
