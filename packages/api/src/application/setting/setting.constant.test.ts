import { describe, expect, it } from "vitest";

import { findSettingDef, maskSecret, SETTING_DEFS, validateSettingValue } from "./setting.constant";

describe("validateSettingValue", () => {
  const intDef = findSettingDef("openai.permitsPerToken")!;
  const boolDef = findSettingDef("slack.enabled")!;
  const numDef = findSettingDef("slack.quietFromHour")!;

  it("정수 범위를 벗어나면 거부한다", () => {
    // 저장을 막지 않으면 런타임에서 조용히 기본값으로 떨어져 원인을 찾기 어렵다.
    expect(validateSettingValue(intDef, "21")).toMatchObject({ ok: false });
    expect(validateSettingValue(intDef, "0")).toMatchObject({ ok: false });
    expect(validateSettingValue(intDef, "20")).toMatchObject({ ok: true, value: "20" });
  });

  it("정수 자리에 소수를 넣으면 거부한다", () => {
    expect(validateSettingValue(intDef, "3.5")).toMatchObject({ ok: false });
  });

  it("숫자가 아닌 값을 거부한다", () => {
    expect(validateSettingValue(intDef, "많이")).toMatchObject({ ok: false });
  });

  it("정수 설정은 소수를 거부하고 범위 내 정수만 받는다", () => {
    expect(validateSettingValue(numDef, "16.5")).toMatchObject({ ok: false });
    expect(validateSettingValue(numDef, "16")).toMatchObject({ ok: true, value: "16" });
  });

  it("boolean 은 true/false 만 받는다", () => {
    expect(validateSettingValue(boolDef, "true")).toMatchObject({ ok: true });
    expect(validateSettingValue(boolDef, "false")).toMatchObject({ ok: true });
    expect(validateSettingValue(boolDef, "1")).toMatchObject({ ok: false });
  });

  it("앞뒤 공백은 저장 전에 떨어뜨린다", () => {
    expect(validateSettingValue(intDef, "  7  ")).toMatchObject({ ok: true, value: "7" });
  });
});

describe("preset 검증", () => {
  const presetDef = findSettingDef("slack.expiryReminderMinutes")!;

  it("목록에 있는 값만 받는다", () => {
    expect(validateSettingValue(presetDef, "30")).toMatchObject({ ok: true, value: "30" });
    expect(validateSettingValue(presetDef, "180")).toMatchObject({ ok: true });
  });

  it("목록 밖의 값은 거부한다", () => {
    // 저장되면 화면에서 아무 버튼도 선택돼 보이지 않아 "왜 안 바뀌지"가 된다.
    expect(validateSettingValue(presetDef, "45")).toMatchObject({ ok: false });
    expect(validateSettingValue(presetDef, "0")).toMatchObject({ ok: false });
    expect(validateSettingValue(presetDef, "많이")).toMatchObject({ ok: false });
  });
});

describe("조용 시간 설정", () => {
  // fallback("20"/"8")은 quiet-hours.ts 의 DEFAULT_QUIET_* 와 같아야 하지만 테스트로 묶지
  // 않는다 — 두 모듈을 한 파일에서 import 하면 setting.store → token.model 이 딸려와,
  // token.model 을 mock 하는 테스트가 같은 워커에 배치될 때 실제 모듈을 먼저 로드해 버린다.
  it("0..23 을 벗어나면 거부한다", () => {
    const fromDef = findSettingDef("slack.quietFromHour")!;
    expect(validateSettingValue(fromDef, "24")).toMatchObject({ ok: false });
    expect(validateSettingValue(fromDef, "-1")).toMatchObject({ ok: false });
    expect(validateSettingValue(fromDef, "0")).toMatchObject({ ok: true });
    expect(validateSettingValue(fromDef, "23")).toMatchObject({ ok: true });
  });
});

describe("maskSecret", () => {
  it("긴 값은 앞뒤만 남긴다", () => {
    expect(maskSecret("xoxb-1234567890-abcdefghij")).toBe("xoxb-123...ghij");
  });

  it("짧은 값은 통째로 가린다", () => {
    // 앞뒤를 남기면 짧은 값은 사실상 전부 노출된다.
    expect(maskSecret("short")).toBe("***");
  });
});

describe("SETTING_DEFS", () => {
  it("키가 중복되지 않는다", () => {
    const keys = SETTING_DEFS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("env 키도 중복되지 않는다", () => {
    // 겹치면 한 env 를 두 설정이 서로 덮어쓴다.
    const envKeys = SETTING_DEFS.map((d) => d.envKey);
    expect(new Set(envKeys).size).toBe(envKeys.length);
  });

  it("OpenAI 동시 요청은 permit 캐노니컬 키 하나만 노출한다", () => {
    const permits = findSettingDef("openai.permitsPerToken")!;
    expect(permits.envKey).toBe("QGRID_OPENAI_PERMITS_PER_TOKEN");
    expect(permits.min).toBe(1);
    expect(permits.max).toBe(20);
    expect(permits.fallback).toBe("3");

    // 워커 시절 키는 화면에서 제거됐다 — resolveOpenAIPermitConfig 의 env 폴백으로만 남는다.
    for (const key of [
      "openai.autoscale",
      "openai.minWorkersPerToken",
      "openai.maxWorkersPerToken",
      "openai.maxEstimatedRssGiB",
      "openai.minHostAvailableGiB",
    ]) {
      expect(findSettingDef(key)).toBeUndefined();
    }
  });

  it("정의되지 않은 키는 찾지 못한다", () => {
    expect(findSettingDef("nope.bad")).toBeUndefined();
  });
});
