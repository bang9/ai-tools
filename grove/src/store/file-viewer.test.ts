import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/platform", () => ({
  readWorkspaceFile: vi.fn(),
  revealInFinder: vi.fn(),
}));

vi.mock("../lib/command", () => ({
  runCommand: vi.fn(),
  runCommandSafely: vi.fn(),
}));

import * as platform from "../lib/platform";
import { runCommand, runCommandSafely } from "../lib/command";
import type { WorkspaceFileContent } from "../types";
import { useFileViewerStore } from "./file-viewer";
import { useTabStore, selectTabsForWorktree } from "./tab";

const TEXT_FILE: WorkspaceFileContent = {
  kind: "text",
  content: "hello\nworld",
  size: 11,
  mimeType: null,
};

function fileTabsFor(worktree: string) {
  return selectTabsForWorktree(useTabStore.getState(), worktree).filter((t) => t.type === "file");
}

describe("useFileViewerStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFileViewerStore.setState({ filesByTab: {} });
    useTabStore.setState({ sessions: {}, activeWorktree: null });
    vi.mocked(runCommand).mockImplementation((action: () => Promise<unknown>) => action());
    vi.mocked(runCommandSafely).mockImplementation((action: () => Promise<unknown>) => action());
    vi.mocked(platform.readWorkspaceFile).mockResolvedValue(TEXT_FILE);
    vi.mocked(platform.revealInFinder).mockResolvedValue(undefined);
  });

  it("opens a file: creates a tab and loads its content", async () => {
    useTabStore.getState().setActiveWorktree("/tmp/wt");

    useFileViewerStore.getState().openFile({
      rootPath: "/tmp/wt",
      path: "src/main.ts",
      name: "main.ts",
    });

    const tabs = fileTabsFor("/tmp/wt");
    expect(tabs).toHaveLength(1);
    const tabId = tabs[0].id;

    await vi.waitFor(() => {
      expect(useFileViewerStore.getState().filesByTab[tabId].status).toBe("loaded");
    });
    expect(platform.readWorkspaceFile).toHaveBeenCalledWith("/tmp/wt", "src/main.ts");
    expect(useFileViewerStore.getState().filesByTab[tabId].data).toEqual(TEXT_FILE);
  });

  it("dedupes an already-open file and activates its tab", async () => {
    useTabStore.getState().setActiveWorktree("/tmp/wt");
    useFileViewerStore
      .getState()
      .openFile({ rootPath: "/tmp/wt", path: "src/main.ts", name: "main.ts" });
    const tabId = fileTabsFor("/tmp/wt")[0].id;
    await vi.waitFor(() => {
      expect(useFileViewerStore.getState().filesByTab[tabId].status).toBe("loaded");
    });

    // Move focus elsewhere, then reopen the same file.
    useTabStore.getState().setActiveTab("terminal");
    useFileViewerStore
      .getState()
      .openFile({ rootPath: "/tmp/wt", path: "src/main.ts", name: "main.ts" });

    expect(fileTabsFor("/tmp/wt")).toHaveLength(1);
    expect(
      selectTabsForWorktree(useTabStore.getState(), "/tmp/wt").find((t) => t.type === "file")?.id,
    ).toBe(tabId);
    // No second read for the deduped open.
    expect(platform.readWorkspaceFile).toHaveBeenCalledTimes(1);
  });

  it("without an active worktree, reveals in Finder and adds no tab", () => {
    useFileViewerStore.getState().openFile({ rootPath: "/root", path: "a.ts", name: "a.ts" });

    expect(platform.revealInFinder).toHaveBeenCalledWith("/root/a.ts");
    expect(useFileViewerStore.getState().filesByTab).toEqual({});
  });

  it("cleans up its entry when the tab is closed", async () => {
    useTabStore.getState().setActiveWorktree("/tmp/wt");
    useFileViewerStore
      .getState()
      .openFile({ rootPath: "/tmp/wt", path: "src/main.ts", name: "main.ts" });
    const tabId = fileTabsFor("/tmp/wt")[0].id;
    await vi.waitFor(() => {
      expect(useFileViewerStore.getState().filesByTab[tabId]).toBeDefined();
    });

    useTabStore.getState().closeTab(tabId);

    expect(useFileViewerStore.getState().filesByTab[tabId]).toBeUndefined();
  });

  it("records a readable error when the read fails", async () => {
    vi.mocked(platform.readWorkspaceFile).mockRejectedValue(new Error("permission denied"));
    useTabStore.getState().setActiveWorktree("/tmp/wt");
    useFileViewerStore.getState().openFile({ rootPath: "/tmp/wt", path: "secret", name: "secret" });
    const tabId = fileTabsFor("/tmp/wt")[0].id;

    await vi.waitFor(() => {
      expect(useFileViewerStore.getState().filesByTab[tabId].status).toBe("error");
    });
    expect(useFileViewerStore.getState().filesByTab[tabId].error).toBe("permission denied");
  });
});
