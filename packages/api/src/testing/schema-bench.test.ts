import { describe, expect, it } from "vitest";

import {
  aggregateBench,
  type BenchRecord,
  checkpointKey,
  classifyBenchText,
  fingerprintFixture,
  formatAggregateTable,
  parseCheckpointLines,
  validateAgainstSchema,
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

describe("validateAgainstSchema — 전체 트리 검증", () => {
  const nested = {
    type: "object",
    properties: {
      scenes: {
        type: "array",
        minItems: 3,
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            advance: { type: "string", enum: ["next", "choice"] },
          },
          required: ["id", "advance"],
        },
      },
    },
    required: ["scenes"],
  };

  it("top-level 키만 있고 속이 빈 응답을 거부한다 (SON-495 교훈)", () => {
    // 상위 키 판정만 하면 이게 통과한다 — 심층 검증의 존재 이유
    const errs = validateAgainstSchema({ scenes: [{}, {}, {}] }, nested);
    expect(errs.length).toBeGreaterThanOrEqual(6); // 각 scene 의 id·advance 누락
    expect(errs[0]).toContain("must have required property");
  });

  it("타입·enum·minItems 위반을 경로와 함께 보고한다", () => {
    expect(validateAgainstSchema({ scenes: [{ id: 1, advance: "next" }] }, nested)).toEqual(
      expect.arrayContaining([expect.stringContaining("fewer than 3 items")]),
    );
    const deep = validateAgainstSchema(
      {
        scenes: [
          { id: "s1", advance: "jump" },
          { id: "s2", advance: "next" },
          { id: "s3", advance: "next" },
        ],
      },
      nested,
    );
    expect(deep).toEqual([
      expect.stringContaining("/scenes/0/advance: must be equal to one of the allowed values"),
    ]);
  });

  it("anyOf/const/nullable union 을 지원한다 (deti 실물 keyword)", () => {
    const sch = {
      type: "object",
      properties: {
        mood: { type: ["string", "null"] },
        kind: { anyOf: [{ const: "a" }, { const: "b" }] },
      },
      required: ["mood", "kind"],
    };
    expect(validateAgainstSchema({ mood: null, kind: "a" }, sch)).toEqual([]);
    // allErrors 라 브랜치별 세부 에러가 함께 나온다 — 두 필드 모두 위반이 잡히는 것만 고정
    const errs = validateAgainstSchema({ mood: 3, kind: "c" }, sch);
    expect(errs.some((e) => e.startsWith("/mood:"))).toBe(true);
    expect(errs.some((e) => e.startsWith("/kind:"))).toBe(true);
  });

  it("oneOf 는 정확히 한 브랜치만 허용한다 — anyOf 로 완화하지 않는다 (2차 검토 #2)", () => {
    const sch = {
      oneOf: [{ type: "object", required: ["a"] }, { type: "object" }],
    };
    // 두 브랜치 모두 매칭 → oneOf 위반. 축약 검증기는 이걸 통과시켰다.
    expect(validateAgainstSchema({ a: 1 }, sch)).toEqual(
      expect.arrayContaining([expect.stringContaining("exactly one")]),
    );
    expect(validateAgainstSchema({ b: 1 }, sch)).toEqual([]);
  });

  it("실측 반증 케이스: anyOf 브랜치 내부의 enum 위반을 잡는다 (e2e 4/4→2/4 원인)", () => {
    // v1 e2e 오판의 축소판 — expression 이 anyOf 브랜치 안 enum 에 걸림
    const sch = {
      type: "object",
      properties: {
        elements: {
          type: "array",
          items: {
            anyOf: [
              {
                type: "object",
                properties: { expression: { type: "string", enum: ["평온", "긴장"] } },
                required: ["expression"],
              },
              { type: "null" },
            ],
          },
        },
      },
      required: ["elements"],
    };
    expect(validateAgainstSchema({ elements: [{ expression: "기대" }] }, sch)).not.toEqual([]);
    expect(validateAgainstSchema({ elements: [{ expression: "평온" }, null] }, sch)).toEqual([]);
  });

  it("정상 인스턴스는 위반 0", () => {
    expect(
      validateAgainstSchema(
        { scenes: [{ id: "1", advance: "next" }, { id: "2", advance: "choice" }, { id: "3", advance: "next" }] },
        nested,
      ),
    ).toEqual([]);
  });
});

describe("classifyBenchText — plainText 계약", () => {
  it("평문 answer 를 JSON 실패로 둔갑시키지 않는다 (tools-only 최종 답변)", () => {
    const c = classifyBenchText("사건 파일 요약: 1976년 단체 사진 사건입니다.", {
      plainText: true,
      validate: (_p, raw) => (raw.trim().length > 0 ? undefined : "empty"),
    });
    expect(c).toMatchObject({
      syntax: "ok",
      contract: "ok",
      topLevel: { prose: false, fenceResidue: false },
    });
  });

  it("펜스 잔존은 평문 계약에서도 잡는다", () => {
    const c = classifyBenchText("```\n요약\n```", { plainText: true });
    expect(c.topLevel.fenceResidue).toBe(true);
  });
});

describe("classifyBenchText — schema 옵션이 심층 검증을 켠다", () => {
  it("속 빈 nested 응답이 contract fail 로 잡힌다", () => {
    const c = classifyBenchText('{"scenes":[{},{},{}]}', {
      schema: {
        type: "object",
        properties: {
          scenes: { type: "array", items: { type: "object", required: ["id"], properties: { id: { type: "string" } } } },
        },
        required: ["scenes"],
      },
    });
    expect(c.contract).toBe("fail");
    expect(c.contractDetail).toContain("schema violations");
  });
});

describe("fingerprintFixture", () => {
  it("내용이 다르면 지문이 다르고, 같으면 같다 — checkpoint 동일성의 근거", () => {
    const a = fingerprintFixture({ prompt: "p", jsonSchema: "{}" });
    expect(fingerprintFixture({ prompt: "p", jsonSchema: "{}" })).toBe(a);
    expect(fingerprintFixture({ prompt: "p2", jsonSchema: "{}" })).not.toBe(a);
    expect(fingerprintFixture({ prompt: "p", jsonSchema: '{"a":1}' })).not.toBe(a);
    expect(fingerprintFixture({ prompt: "p", jsonSchema: "{}", tools: [{ name: "t" }] })).not.toBe(a);
  });

  it("지문이 checkpoint 키에 반영돼 fixture 수정 후 옛 결과가 재사용되지 않는다", () => {
    const base = { fixture: "f", model: "m", mode: "generate" as const, iteration: 0 };
    expect(checkpointKey({ ...base, fixtureHash: "aaaa" })).not.toBe(
      checkpointKey({ ...base, fixtureHash: "bbbb" }),
    );
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
    const withDifferentDuration: BenchRecord = { ...record, durationMs: 99 };
    expect(checkpointKey(record)).toBe(checkpointKey(withDifferentDuration));
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

  it("델타≠done 불일치를 집계하고 pass 에서도 제외한다 (2차 검토 #7)", () => {
    const rows = aggregateBench([rec({ deltaDoneMismatch: true }), rec({ iteration: 1 })]);
    expect(rows[0]!.deltaDoneMismatches).toBe(1);
    expect(rows[0]!.passes).toBe(1); // mismatch 건은 syntax/contract ok 여도 pass 아님
  });

  it("형태 위반(펜스 잔존 등)은 contract ok 여도 pass 가 아니다 (2차 검토 #7)", () => {
    const rows = aggregateBench([
      rec({
        classification: {
          syntax: "ok",
          contract: "ok",
          topLevel: { wrapperKey: false, fenceResidue: true, prose: false },
        },
      }),
      rec({ iteration: 1 }),
    ]);
    expect(rows[0]!.passes).toBe(1);
    expect(rows[0]!.fenceResidue).toBe(1);
  });

  it("표 렌더가 헤더+행 형태를 유지한다", () => {
    const table = formatAggregateTable(aggregateBench([rec({})]));
    const lines = table.split("\n");
    expect(lines[0]).toContain("rate");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("100.0%");
  });
});
