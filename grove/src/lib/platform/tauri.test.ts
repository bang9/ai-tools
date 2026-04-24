import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFullscreen: vi.fn(),
    onResized: vi.fn(),
  }),
}));

import {
  getCommandErrorMessage,
  getCommitDiffContext,
  getWorkingDiffContext,
} from "./tauri";

describe("getCommandErrorMessage", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("redacts local clone paths and credentials", () => {
    const message = getCommandErrorMessage(
      "Error: git clone failed: Cloning into '/Users/test/.grove/github.com/bang9/repo/source'...\nhttps://token@github.com: Permission denied",
    );

    expect(message).toContain("Cloning repository...");
    expect(message).toContain("https://***@github.com");
    expect(message).not.toContain("/Users/test/.grove");
    expect(message).not.toContain("token@");
  });

  it("redacts standalone filesystem paths", () => {
    const message = getCommandErrorMessage(
      "Failed to open repo at /private/tmp/grove-dev/grove/source",
    );

    expect(message).toContain("[path]");
    expect(message).not.toContain("/private/tmp/grove-dev");
  });

  it("invokes the working diff context command with the expected payload", async () => {
    invokeMock.mockResolvedValue(["line"]);

    const result = await getWorkingDiffContext("/repo", "src/app.ts", 5, 20);

    expect(result).toEqual(["line"]);
    expect(invokeMock).toHaveBeenCalledWith("get_working_diff_context", {
      worktreePath: "/repo",
      path: "src/app.ts",
      startLine: 5,
      lineCount: 20,
    });
  });

  it("invokes the commit diff context command with the expected payload", async () => {
    invokeMock.mockResolvedValue(["line"]);

    const result = await getCommitDiffContext("/repo", "abc123", "src/app.ts", "src/app.ts", 2, 10);

    expect(result).toEqual(["line"]);
    expect(invokeMock).toHaveBeenCalledWith("get_commit_diff_context", {
      worktreePath: "/repo",
      hash: "abc123",
      path: "src/app.ts",
      oldPath: "src/app.ts",
      startLine: 2,
      lineCount: 10,
    });
  });
});
