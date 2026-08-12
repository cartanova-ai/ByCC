import { execFileSync } from "node:child_process";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock("commander", () => ({
  Command: class {
    name() {
      return this;
    }
    version() {
      return this;
    }
    description() {
      return this;
    }
    option() {
      return this;
    }
    action() {
      return this;
    }
    parse() {}
  },
}));

const { ensureLatestRuntimeCliDependencies, RUNTIME_CLI_DEPENDENCIES } = await import("./cli");
const execFileSyncMock = vi.mocked(execFileSync);

describe("runtime CLI dependency updates", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
  });

  it("Claude Code만 런타임 의존성으로 관리한다", () => {
    expect(RUNTIME_CLI_DEPENDENCIES).toEqual([
      expect.objectContaining({
        command: "claude",
        packageName: "@anthropic-ai/claude-code",
      }),
    ]);
  });

  it("Codex CLI를 확인하거나 설치하지 않는다", () => {
    execFileSyncMock.mockImplementation((command, args) => {
      if (command === "claude") return "1.2.3\n" as never;
      if (command === "npm" && args?.[0] === "view") return "1.2.3\n" as never;
      throw new Error(`unexpected command: ${command} ${(args ?? []).join(" ")}`);
    });

    ensureLatestRuntimeCliDependencies();

    const invocations = execFileSyncMock.mock.calls.map(([command, args]) =>
      [command, ...(args ?? [])].join(" "),
    );
    expect(invocations).toContain("claude --version");
    expect(invocations).toContain("npm view @anthropic-ai/claude-code version");
    expect(invocations.join("\n")).not.toMatch(/codex|@openai\/codex/i);
  });
});
