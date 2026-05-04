import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/platform", () => ({
  listDirectoryFiles: vi.fn(),
}));

vi.mock("../lib/command", () => ({
  runCommandSafely: vi.fn(),
}));

import * as platform from "../lib/platform";
import { runCommandSafely } from "../lib/command";
import { useFileBrowserStore } from "./file-browser";

describe("useFileBrowserStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFileBrowserStore.setState({
      worktreePath: "/tmp/repo",
      entries: [],
      loaded: false,
      loading: false,
    });
    vi.mocked(runCommandSafely).mockImplementation(
      async (action: () => Promise<unknown>) => action() as Promise<null>,
    );
    vi.mocked(platform.listDirectoryFiles).mockResolvedValue([
      { path: "src", name: "src", entryType: "directory", depth: 0 },
      { path: "src/main.ts", name: "main.ts", entryType: "file", depth: 1 },
    ]);
  });

  it("loads directory file entries for the current worktree", async () => {
    await useFileBrowserStore.getState().loadDirectoryFiles();

    expect(platform.listDirectoryFiles).toHaveBeenCalledWith("/tmp/repo");
    expect(useFileBrowserStore.getState().entries).toEqual([
      { path: "src", name: "src", entryType: "directory", depth: 0 },
      { path: "src/main.ts", name: "main.ts", entryType: "file", depth: 1 },
    ]);
    expect(useFileBrowserStore.getState().loaded).toBe(true);
    expect(useFileBrowserStore.getState().loading).toBe(false);
  });

  it("resets entries when the worktree changes", () => {
    useFileBrowserStore.setState({
      entries: [
        { path: "src", name: "src", entryType: "directory", depth: 0 },
      ],
      loaded: true,
    });

    useFileBrowserStore.getState().setWorktreePath("/tmp/other");

    expect(useFileBrowserStore.getState().entries).toEqual([]);
    expect(useFileBrowserStore.getState().loaded).toBe(false);
  });
});
