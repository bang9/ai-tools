import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/platform", () => ({
  getStatus: vi.fn(),
  getCommits: vi.fn(),
  getBehindCount: vi.fn(),
  mergeDefaultBranch: vi.fn(),
  getWorkingDiff: vi.fn(),
  getCommitDiff: vi.fn(),
  stageFile: vi.fn(),
  stageFiles: vi.fn(),
  unstageFile: vi.fn(),
  unstageFiles: vi.fn(),
  discardFile: vi.fn(),
  stageHunk: vi.fn(),
  unstageHunk: vi.fn(),
  discardHunk: vi.fn(),
  stageLines: vi.fn(),
  unstageLines: vi.fn(),
  discardLines: vi.fn(),
}));

vi.mock("../lib/command", () => ({
  runCommandSafely: vi.fn(),
  runCommand: vi.fn(),
}));

vi.mock("../store/toast", () => ({
  useToastStore: {
    getState: vi.fn(() => ({ addToast: vi.fn() })),
  },
}));

import * as tauri from "../lib/platform";
import { runCommand, runCommandSafely } from "../lib/command";
import { useDiffStore } from "./diff";

describe("line selection (per-file scoped)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDiffStore.setState({ selectedLines: new Map() });
  });

  it("selectLine sets a single line for a file", () => {
    useDiffStore.getState().selectLine("file-a", 5);
    expect(useDiffStore.getState().selectedLines.get("file-a")).toEqual(new Set([5]));
  });

  it("toggleLine adds and removes for a file", () => {
    useDiffStore.getState().toggleLine("file-a", 3);
    expect(useDiffStore.getState().selectedLines.get("file-a")).toEqual(new Set([3]));
    useDiffStore.getState().toggleLine("file-a", 3);
    expect(useDiffStore.getState().selectedLines.get("file-a")?.size ?? 0).toBe(0);
  });

  it("selectLineRange selects inclusive range for a file", () => {
    useDiffStore.getState().selectLineRange("file-a", 2, 5);
    expect(useDiffStore.getState().selectedLines.get("file-a")).toEqual(new Set([2, 3, 4, 5]));
  });

  it("selectLineRange works in reverse", () => {
    useDiffStore.getState().selectLineRange("file-a", 5, 2);
    expect(useDiffStore.getState().selectedLines.get("file-a")).toEqual(new Set([2, 3, 4, 5]));
  });

  it("selections are independent per file", () => {
    useDiffStore.getState().selectLine("file-a", 1);
    useDiffStore.getState().selectLine("file-b", 2);
    expect(useDiffStore.getState().selectedLines.get("file-a")).toEqual(new Set([1]));
    expect(useDiffStore.getState().selectedLines.get("file-b")).toEqual(new Set([2]));
  });

  it("clearSelection empties all files", () => {
    useDiffStore.getState().selectLine("file-a", 1);
    useDiffStore.getState().selectLine("file-b", 2);
    useDiffStore.getState().clearSelection();
    expect(useDiffStore.getState().selectedLines.size).toBe(0);
  });
});

describe("batch file mutations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDiffStore.setState({
      worktreePath: "/tmp/repo",
      selectedView: "changes",
      selectedFile: null,
      isViewingStaged: false,
      selectedLines: new Map(),
    });
    vi.mocked(runCommandSafely).mockImplementation(
      async (action: () => Promise<unknown>) => action() as Promise<null>,
    );
    vi.mocked(tauri.getStatus).mockResolvedValue([]);
    vi.mocked(tauri.stageFiles).mockResolvedValue();
    vi.mocked(tauri.unstageFiles).mockResolvedValue();
  });

  it("stageFiles uses one backend batch call and one refresh", async () => {
    await useDiffStore.getState().stageFiles(["a.ts", "b.ts"]);

    expect(tauri.stageFiles).toHaveBeenCalledWith("/tmp/repo", ["a.ts", "b.ts"]);
    expect(tauri.getStatus).toHaveBeenCalledTimes(1);
  });

  it("unstageFiles uses one backend batch call and one refresh", async () => {
    await useDiffStore.getState().unstageFiles(["a.ts", "b.ts"]);

    expect(tauri.unstageFiles).toHaveBeenCalledWith("/tmp/repo", ["a.ts", "b.ts"]);
    expect(tauri.getStatus).toHaveBeenCalledTimes(1);
  });
});

describe("refreshAll", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDiffStore.setState({
      worktreePath: "/tmp/repo",
      selectedView: "changes",
      selectedFile: null,
      isViewingStaged: false,
      fileStatuses: [],
    });
    vi.mocked(runCommandSafely).mockImplementation(
      async (action: () => Promise<unknown>) => action() as Promise<null>,
    );
    vi.mocked(tauri.getStatus).mockResolvedValue([]);
    vi.mocked(tauri.getCommits).mockResolvedValue([]);
    vi.mocked(tauri.getBehindCount).mockResolvedValue({ behind: 0, defaultBranch: "main" });
    vi.mocked(tauri.getWorkingDiff).mockResolvedValue({
      path: "foo.ts",
      status: "modified",
      hunks: [],
      displayLineCount: 0,
    });
  });

  it("no-ops when worktreePath is not set", async () => {
    useDiffStore.setState({ worktreePath: null });
    await useDiffStore.getState().refreshAll();
    expect(tauri.getStatus).not.toHaveBeenCalled();
    expect(tauri.getCommits).not.toHaveBeenCalled();
    expect(tauri.getBehindCount).not.toHaveBeenCalled();
  });

  it("fetches status, commits, and behindCount in parallel", async () => {
    await useDiffStore.getState().refreshAll();
    expect(tauri.getStatus).toHaveBeenCalledTimes(1);
    expect(tauri.getCommits).toHaveBeenCalledTimes(1);
    expect(tauri.getBehindCount).toHaveBeenCalledTimes(1);
  });

  it("re-loads selected working diff when in changes view", async () => {
    useDiffStore.setState({
      selectedFile: "foo.ts",
      selectedView: "changes",
      isViewingStaged: false,
    });
    await useDiffStore.getState().refreshAll();
    expect(tauri.getWorkingDiff).toHaveBeenCalledWith("/tmp/repo", "foo.ts");
  });

  it("does not reload working diff when viewing a commit", async () => {
    useDiffStore.setState({
      selectedFile: "foo.ts",
      selectedView: { hash: "abc" } as unknown as "changes",
    });
    await useDiffStore.getState().refreshAll();
    expect(tauri.getWorkingDiff).not.toHaveBeenCalled();
  });

  it("does not reload working diff when no file is selected", async () => {
    useDiffStore.setState({
      selectedFile: null,
      selectedView: "changes",
    });
    await useDiffStore.getState().refreshAll();
    expect(tauri.getWorkingDiff).not.toHaveBeenCalled();
  });

  it("passes staged prefix to getWorkingDiff when isViewingStaged is true", async () => {
    useDiffStore.setState({
      selectedFile: "foo.ts",
      selectedView: "changes",
      isViewingStaged: true,
    });
    await useDiffStore.getState().refreshAll();
    expect(tauri.getWorkingDiff).toHaveBeenCalledWith("/tmp/repo", "staged:foo.ts");
  });
});

describe("polling equality gates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDiffStore.setState({
      worktreePath: "/tmp/repo",
      fileStatuses: [],
      commits: [],
      behindCount: 0,
    });
    vi.mocked(runCommandSafely).mockImplementation(
      async (action: () => Promise<unknown>) => action() as Promise<null>,
    );
  });

  it("loadStatus keeps same array reference when content is unchanged", async () => {
    const initial = [{ path: "a.ts", status: "modified" as const, staged: false }];
    useDiffStore.setState({ fileStatuses: initial });
    vi.mocked(tauri.getStatus).mockResolvedValue([
      { path: "a.ts", status: "modified", staged: false },
    ]);

    await useDiffStore.getState().loadStatus();
    expect(useDiffStore.getState().fileStatuses).toBe(initial);
  });

  it("loadStatus replaces array when any field differs", async () => {
    const initial = [{ path: "a.ts", status: "modified" as const, staged: false }];
    useDiffStore.setState({ fileStatuses: initial });
    vi.mocked(tauri.getStatus).mockResolvedValue([
      { path: "a.ts", status: "modified", staged: true }, // staged flipped
    ]);

    await useDiffStore.getState().loadStatus();
    expect(useDiffStore.getState().fileStatuses).not.toBe(initial);
    expect(useDiffStore.getState().fileStatuses[0].staged).toBe(true);
  });

  it("loadCommits keeps same array when hash sequence unchanged", async () => {
    const initial = [{ hash: "a", shortHash: "a", message: "x", author: "x", date: "x" }];
    useDiffStore.setState({ commits: initial });
    vi.mocked(tauri.getCommits).mockResolvedValue([
      { hash: "a", shortHash: "a", message: "different", author: "y", date: "z" },
    ]);

    await useDiffStore.getState().loadCommits();
    expect(useDiffStore.getState().commits).toBe(initial);
  });

  it("loadCommits replaces array when hash changes", async () => {
    const initial = [{ hash: "a", shortHash: "a", message: "x", author: "x", date: "x" }];
    useDiffStore.setState({ commits: initial });
    vi.mocked(tauri.getCommits).mockResolvedValue([
      { hash: "b", shortHash: "b", message: "x", author: "x", date: "x" },
    ]);

    await useDiffStore.getState().loadCommits();
    expect(useDiffStore.getState().commits).not.toBe(initial);
  });

  it("loadBehindCount skips set when value unchanged", async () => {
    useDiffStore.setState({ behindCount: 3 });
    vi.mocked(tauri.getBehindCount).mockResolvedValue({
      behind: 3,
      defaultBranch: "main",
    });
    const spy = vi.spyOn(useDiffStore, "setState");

    await useDiffStore.getState().loadBehindCount();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("mergeDefaultBranch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDiffStore.setState({
      worktreePath: "/tmp/repo",
      selectedView: "changes",
      selectedFile: null,
      isViewingStaged: false,
      merging: false,
    });
    vi.mocked(runCommandSafely).mockImplementation(
      async (action: () => Promise<unknown>) => action() as Promise<null>,
    );
    vi.mocked(runCommand).mockImplementation(async (action: () => Promise<unknown>) => {
      await action();
    });
    vi.mocked(tauri.getStatus).mockResolvedValue([]);
    vi.mocked(tauri.getCommits).mockResolvedValue([]);
    vi.mocked(tauri.getBehindCount).mockResolvedValue({ behind: 0, defaultBranch: "main" });
    vi.mocked(tauri.mergeDefaultBranch).mockResolvedValue();
  });

  it("no-ops when worktreePath is not set", async () => {
    useDiffStore.setState({ worktreePath: null });
    await useDiffStore.getState().mergeDefaultBranch();
    expect(tauri.mergeDefaultBranch).not.toHaveBeenCalled();
  });

  it("invokes merge then refreshes all", async () => {
    await useDiffStore.getState().mergeDefaultBranch();
    expect(tauri.mergeDefaultBranch).toHaveBeenCalledWith("/tmp/repo");
    expect(tauri.getStatus).toHaveBeenCalled();
    expect(tauri.getCommits).toHaveBeenCalled();
    expect(tauri.getBehindCount).toHaveBeenCalled();
  });

  it("clears merging flag even when merge throws", async () => {
    vi.mocked(runCommand).mockRejectedValueOnce(new Error("conflict"));
    await useDiffStore.getState().mergeDefaultBranch();
    expect(useDiffStore.getState().merging).toBe(false);
  });
});
