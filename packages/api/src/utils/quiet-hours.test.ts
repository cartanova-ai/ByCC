import { describe, expect, it } from "vitest";

import { isQuietHours } from "./quiet-hours";

/** 한국 시간을 UTC 로 표현한다 — dev0 가 UTC 라 이 변환이 실제 운영 조건이다. */
function seoul(iso: string): Date {
  return new Date(`${iso}+09:00`);
}

describe("isQuietHours", () => {
  it("평일 업무 시간에는 알린다", () => {
    // 2026-08-05 는 수요일
    expect(isQuietHours(seoul("2026-08-05T09:00:00"))).toBe(false);
    expect(isQuietHours(seoul("2026-08-05T14:30:00"))).toBe(false);
    expect(isQuietHours(seoul("2026-08-05T19:59:00"))).toBe(false);
  });

  it("평일 20시부터 조용해진다", () => {
    expect(isQuietHours(seoul("2026-08-05T20:00:00"))).toBe(true);
    expect(isQuietHours(seoul("2026-08-05T23:59:00"))).toBe(true);
  });

  it("자정을 넘겨 8시 전까지 조용하다", () => {
    expect(isQuietHours(seoul("2026-08-06T00:00:00"))).toBe(true);
    expect(isQuietHours(seoul("2026-08-06T07:59:00"))).toBe(true);
    expect(isQuietHours(seoul("2026-08-06T08:00:00"))).toBe(false);
  });

  it("주말은 시간과 무관하게 조용하다", () => {
    // 2026-08-08 토요일, 08-09 일요일
    expect(isQuietHours(seoul("2026-08-08T10:00:00"))).toBe(true);
    expect(isQuietHours(seoul("2026-08-08T15:00:00"))).toBe(true);
    expect(isQuietHours(seoul("2026-08-09T12:00:00"))).toBe(true);
  });

  it("월요일 8시에 다시 알리기 시작한다", () => {
    expect(isQuietHours(seoul("2026-08-10T07:59:00"))).toBe(true);
    expect(isQuietHours(seoul("2026-08-10T08:00:00"))).toBe(false);
  });

  it("서버가 UTC 여도 한국 시간으로 판정한다", () => {
    // UTC 23시 = 한국 다음날 08시 → 업무 시간
    expect(isQuietHours(new Date("2026-08-04T23:00:00Z"))).toBe(false);
    // UTC 12시 = 한국 21시 → 조용 시간
    expect(isQuietHours(new Date("2026-08-05T12:00:00Z"))).toBe(true);
    // UTC 금요일 22시 = 한국 토요일 07시 → 주말
    expect(isQuietHours(new Date("2026-08-07T22:00:00Z"))).toBe(true);
  });
});
