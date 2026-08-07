import { describe, expect, it } from "vitest";

import { buildDigestContext } from "./expired-token-digest";

const userMap = new Map([
  ["yds", "U09NAJUQSFQ"],
  ["haze", "U09N96NHZB7"],
]);

describe("buildDigestContext", () => {
  it("매핑된 토큰은 멘션으로 개인에게 꽂는다", () => {
    const text = buildDigestContext([{ name: "anthropic/yds", provider: "anthropic" }], userMap);

    expect(text).toBe("<@U09NAJUQSFQ> anthropic");
  });

  it("공용 계정처럼 매핑이 없으면 멘션 없이 이름만 남긴다", () => {
    const text = buildDigestContext(
      [{ name: "anthropic/dev-common", provider: "anthropic" }],
      userMap,
    );

    expect(text).toBe("anthropic/dev-common (anthropic)");
  });

  it("같은 사람의 provider 별 토큰을 각각 줄로 나열한다", () => {
    const text = buildDigestContext(
      [
        { name: "anthropic/yds", provider: "anthropic" },
        { name: "openai/yds", provider: "openai" },
      ],
      userMap,
    );

    expect(text.split("\n")).toEqual(["<@U09NAJUQSFQ> anthropic", "<@U09NAJUQSFQ> openai"]);
  });

  it("provider prefix 없이 저장된 이름도 매핑한다", () => {
    const text = buildDigestContext([{ name: "haze", provider: "anthropic" }], userMap);

    expect(text).toBe("<@U09N96NHZB7> anthropic");
  });

  it("이름이 없는 토큰도 줄을 잃지 않는다", () => {
    const text = buildDigestContext([{ name: null, provider: "openai" }], userMap);

    expect(text).toBe("unnamed (openai)");
  });
});
