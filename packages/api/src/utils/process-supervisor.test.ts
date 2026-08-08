import { describe, expect, it } from "vitest";

import { detectSupervisor } from "./process-supervisor";

describe("detectSupervisor", () => {
  it("pm2 아래에서는 pm2 로 판별한다", () => {
    // pm2 는 자식에게 pm_id 를 넣는다. "0" 이 흔한 값이라 falsy 검사로는 놓친다.
    expect(detectSupervisor({ pm_id: "0" })).toBe("pm2");
  });

  it("systemd 환경변수만으로는 재시작 보장을 가정하지 않는다", () => {
    expect(detectSupervisor({ INVOCATION_ID: "abc123" })).toBeNull();
  });

  it("로컬 실행에서는 null 이다", () => {
    // 종료해도 다시 띄워줄 주체가 없어 재시작을 막아야 한다.
    expect(detectSupervisor({})).toBeNull();
  });

  it("빈 문자열도 pm2 로 인정한다", () => {
    // 값이 아니라 존재 여부가 신호다. pm_id 가 빈 문자열로 오는 환경이 있어도 pm2 다.
    expect(detectSupervisor({ pm_id: "" })).toBe("pm2");
  });
});
