import { describe, expect, it } from "vitest";

import { buildReminderContext } from "./expired-token-reminder";

const userMap = new Map([
  ["yds", "U09NAJUQSFQ"],
  ["haze", "U09N96NHZB7"],
]);

describe("buildReminderContext", () => {
  it("매핑된 토큰은 멘션으로 개인에게 꽂는다", () => {
    const text = buildReminderContext([{ name: "anthropic/yds", provider: "anthropic" }], userMap);

    expect(text).toBe("<@U09NAJUQSFQ> anthropic/yds");
  });

  it("공용 계정처럼 매핑이 없으면 멘션 없이 이름만 남긴다", () => {
    const text = buildReminderContext(
      [{ name: "anthropic/dev-common", provider: "anthropic" }],
      userMap,
    );

    expect(text).toBe("anthropic/dev-common");
  });

  it("같은 사람의 provider 별 토큰을 각각 구분해 보여준다", () => {
    const text = buildReminderContext(
      [
        { name: "anthropic/yds", provider: "anthropic" },
        { name: "openai/yds", provider: "openai" },
      ],
      userMap,
    );

    // 멘션만 두 번 나오면 어느 토큰인지 알 수 없다 — 토큰명이 함께 있어야 한다.
    expect(text.split("\n")).toEqual([
      "<@U09NAJUQSFQ> anthropic/yds",
      "<@U09NAJUQSFQ> openai/yds",
    ]);
  });

  it("provider prefix 없이 저장된 이름도 매핑한다", () => {
    const text = buildReminderContext([{ name: "haze", provider: "anthropic" }], userMap);

    expect(text).toBe("<@U09N96NHZB7> haze");
  });

  it("이름이 없는 토큰도 줄을 잃지 않는다", () => {
    const text = buildReminderContext([{ name: null, provider: "openai" }], userMap);

    expect(text).toBe("unnamed");
  });
});
