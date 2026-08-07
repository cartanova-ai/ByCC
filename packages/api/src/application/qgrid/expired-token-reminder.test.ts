import { describe, expect, it } from "vitest";

import { buildReminderContext } from "./expired-token-reminder";

const userMap = new Map([
  ["yds", "U09NAJUQSFQ"],
  ["haze", "U09N96NHZB7"],
]);

describe("buildReminderContext", () => {
  it("1건이면 제목에 있는 토큰명을 본문에서 반복하지 않는다", () => {
    const text = buildReminderContext([{ name: "anthropic/yds", provider: "anthropic" }], userMap);

    expect(text).toBe("<@U09NAJUQSFQ>\n재로그인이 필요합니다");
  });

  it("1건이고 매핑이 없으면 안내만 남는다", () => {
    const text = buildReminderContext(
      [{ name: "anthropic/dev-common", provider: "anthropic" }],
      userMap,
    );

    expect(text).toBe("재로그인이 필요합니다");
  });

  it("여러 건이면 제목이 건수라 본문에 토큰명을 남긴다", () => {
    const text = buildReminderContext(
      [
        { name: "anthropic/yds", provider: "anthropic" },
        { name: "openai/yds", provider: "openai" },
      ],
      userMap,
    );

    expect(text.split("\n")).toEqual([
      "<@U09NAJUQSFQ> anthropic/yds",
      "<@U09NAJUQSFQ> openai/yds",
      "재로그인이 필요합니다",
    ]);
  });

  it("여러 건 중 매핑 없는 공용 계정은 이름만 남긴다", () => {
    const text = buildReminderContext(
      [
        { name: "anthropic/haze", provider: "anthropic" },
        { name: "anthropic/dev-common", provider: "anthropic" },
      ],
      userMap,
    );

    expect(text.split("\n")).toEqual([
      "<@U09N96NHZB7> anthropic/haze",
      "anthropic/dev-common",
      "재로그인이 필요합니다",
    ]);
  });

  it("이름이 없는 토큰도 줄을 잃지 않는다", () => {
    const text = buildReminderContext(
      [
        { name: null, provider: "openai" },
        { name: "anthropic/haze", provider: "anthropic" },
      ],
      userMap,
    );

    expect(text.split("\n")).toEqual([
      "unnamed",
      "<@U09N96NHZB7> anthropic/haze",
      "재로그인이 필요합니다",
    ]);
  });
});
