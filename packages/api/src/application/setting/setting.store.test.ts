import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getSetting,
  isStored,
  loadSettings,
  resetSetting,
  saveSetting,
  setSettingChangeHandler,
} from "./setting.store";

const settingModelMock = {
  clearByKey: vi.fn(),
  findAllAsMap: vi.fn(),
  setByKey: vi.fn(),
};

describe("setting change handler", () => {
  beforeEach(async () => {
    settingModelMock.clearByKey.mockReset();
    settingModelMock.findAllAsMap.mockReset();
    settingModelMock.setByKey.mockReset();
    settingModelMock.clearByKey.mockResolvedValue(undefined);
    settingModelMock.findAllAsMap.mockResolvedValue(new Map());
    settingModelMock.setByKey.mockResolvedValue(undefined);
    setSettingChangeHandler(null);
    await loadSettings(settingModelMock);
  });

  it("DB 저장과 캐시 갱신이 끝난 뒤 변경을 알린다", async () => {
    const observed: Array<[string, string | undefined]> = [];
    setSettingChangeHandler((key) => {
      observed.push([key, getSetting(key, "TEST_SETTING")]);
    });

    await saveSetting("slack.userMap", "yds:U-NEW", settingModelMock);

    expect(settingModelMock.setByKey).toHaveBeenCalledWith("slack.userMap", "yds:U-NEW");
    expect(observed).toEqual([["slack.userMap", "yds:U-NEW"]]);
  });

  it("reset 후 저장값을 지운 상태로 변경을 알린다", async () => {
    settingModelMock.findAllAsMap.mockResolvedValueOnce(
      new Map([["slack.expiryReminderMinutes", "30"]]),
    );
    await loadSettings(settingModelMock);
    const observed: boolean[] = [];
    setSettingChangeHandler((key) => observed.push(isStored(key)));

    await resetSetting("slack.expiryReminderMinutes", settingModelMock);

    expect(settingModelMock.clearByKey).toHaveBeenCalledWith("slack.expiryReminderMinutes");
    expect(observed).toEqual([false]);
  });

  it("설정 로드는 변경 이벤트를 만들지 않는다", async () => {
    const handler = vi.fn();
    setSettingChangeHandler(handler);
    settingModelMock.findAllAsMap.mockResolvedValueOnce(new Map([["slack.userMap", "yds:U1"]]));

    await loadSettings(settingModelMock);

    expect(handler).not.toHaveBeenCalled();
  });

  it("handler 실패가 이미 성공한 저장을 실패로 바꾸지 않는다", async () => {
    setSettingChangeHandler(() => {
      throw new Error("reschedule failed");
    });

    await expect(saveSetting("slack.userMap", "yds:U1", settingModelMock)).resolves.toBeUndefined();
    expect(getSetting("slack.userMap", "TEST_SETTING")).toBe("yds:U1");
  });

  it("DB 저장이 실패하면 캐시와 handler를 건드리지 않는다", async () => {
    const handler = vi.fn();
    setSettingChangeHandler(handler);
    settingModelMock.setByKey.mockRejectedValueOnce(new Error("db failed"));

    await expect(saveSetting("slack.userMap", "yds:U1", settingModelMock)).rejects.toThrow(
      "db failed",
    );

    expect(getSetting("slack.userMap", "TEST_SETTING")).toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
  });
});
