import { beforeEach, describe, expect, it, vi } from "vitest";

import { getSlackUserMap } from "./slack-user-map";

const getSettingMock = vi.fn();

describe("getSlackUserMap", () => {
  let raw = "yds:U-OLD";

  beforeEach(() => {
    raw = "yds:U-OLD";
    getSettingMock.mockReset();
    getSettingMock.mockImplementation(() => raw);
  });

  it("설정이 바뀌면 다음 조회부터 새 매핑을 사용한다", () => {
    expect(getSlackUserMap(getSettingMock).get("yds")).toBe("U-OLD");

    raw = "yds:U-NEW";

    expect(getSlackUserMap(getSettingMock).get("yds")).toBe("U-NEW");
  });
});
