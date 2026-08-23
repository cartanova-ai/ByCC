import { describe, expect, it } from "vitest";

import { findSettingDef, maskSecret, SETTING_DEFS, validateSettingValue } from "./setting.constant";

describe("validateSettingValue", () => {
  const intDef = findSettingDef("slack.quietFromHour")!;
  const boolDef = findSettingDef("slack.enabled")!;

  it("정수 범위를 벗어나면 거부한다", () => {
    // 저장을 막지 않으면 런타임에서 조용히 기본값으로 떨어져 원인을 찾기 어렵다.
    expect(validateSettingValue(intDef, "24")).toMatchObject({ ok: false });
    expect(validateSettingValue(intDef, "-1")).toMatchObject({ ok: false });
    expect(validateSettingValue(intDef, "23")).toMatchObject({ ok: true, value: "23" });
  });

  it("정수 자리에 소수를 넣으면 거부한다", () => {
    expect(validateSettingValue(intDef, "3.5")).toMatchObject({ ok: false });
  });

  it("숫자가 아닌 값을 거부한다", () => {
    expect(validateSettingValue(intDef, "많이")).toMatchObject({ ok: false });
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
  it("token window keepalive 비상 스위치를 즉시 적용 설정으로 등록한다", () => {
    expect(findSettingDef("qgrid.tokenWindowKeepaliveEnabled")).toMatchObject({
      group: "qgrid",
      kind: "boolean",
      applies: "immediate",
      fallback: "true",
    });
    expect(findSettingDef("qgrid.tokenWindowKeepaliveEnabled")?.envKey).toBeUndefined();
  });

  it("키가 중복되지 않는다", () => {
    const keys = SETTING_DEFS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("env 키도 중복되지 않는다", () => {
    // 겹치면 한 env 를 두 설정이 서로 덮어쓴다.
    const envKeys = SETTING_DEFS.flatMap((d) => (d.envKey ? [d.envKey] : []));
    expect(new Set(envKeys).size).toBe(envKeys.length);
  });

  it("OpenAI 동시성 설정 키는 더 이상 존재하지 않는다", () => {
    // direct 전환으로 요청은 Anthropic 과 동일하게 상한 없이 나간다 — permit/워커
    // 시절의 어떤 키도 화면에 노출하지 않는다. 전송 방식(QGRID_OPENAI_TRANSPORT)은
    // env 전용이라 설정 화면 대상이 아니다.
    for (const key of [
      "openai.permitsPerToken",
      "openai.autoscale",
      "openai.minWorkersPerToken",
      "openai.maxWorkersPerToken",
      "openai.maxEstimatedRssGiB",
      "openai.minHostAvailableGiB",
    ]) {
      expect(findSettingDef(key)).toBeUndefined();
    }
    expect(SETTING_DEFS.every((d) => !d.key.startsWith("openai."))).toBe(true);
  });

  it("정의되지 않은 키는 찾지 못한다", () => {
    expect(findSettingDef("nope.bad")).toBeUndefined();
  });
});
