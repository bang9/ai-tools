import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mocks must be declared before importing the module under test.
const loadCommits = vi.fn().mockResolvedValue(undefined);
const loadBehindCount = vi.fn().mockResolvedValue(undefined);
const loadWorkingDiff = vi.fn().mockResolvedValue(undefined);

// Simulates the gated `set()` behavior in the real store: if the next
// payload is assigned for this tick, replace the array reference; otherwise
// leave it identical so runStatusJob treats it as "unchanged".
let nextFileStatuses: unknown[] | null = null;
const loadStatus = vi.fn().mockImplementation(async () => {
  if (nextFileStatuses !== null) {
    storeState.fileStatuses = nextFileStatuses;
    nextFileStatuses = null;
  }
});

let storeState = {
  worktreePath: "/repo",
  fileStatuses: [] as unknown[],
  selectedFile: null as string | null,
  selectedView: "changes" as "changes" | { hash: string },
  isViewingStaged: false,
  loadStatus,
  loadCommits,
  loadBehindCount,
  loadWorkingDiff,
};

vi.mock("../store/diff", () => ({
  useDiffStore: {
    getState: () => storeState,
  },
}));

// Stub `window` so the module can register a focus listener in the Node test env.
const focusHandlers: Array<() => void> = [];
const mockAddEventListener = vi.fn((type: string, handler: EventListener) => {
  if (type === "focus") focusHandlers.push(handler as () => void);
});
const mockRemoveEventListener = vi.fn((type: string, handler: EventListener) => {
  if (type === "focus") {
    const idx = focusHandlers.indexOf(handler as () => void);
    if (idx >= 0) focusHandlers.splice(idx, 1);
  }
});
vi.stubGlobal("window", {
  addEventListener: mockAddEventListener,
  removeEventListener: mockRemoveEventListener,
});

import {
  DIFF_COMMITS_JOB_KEY,
  DIFF_STATUS_JOB_KEY,
  disposeDiffSync,
  initDiffSync,
} from "./diff-sync";
import { runJobNow, startSyncManager, stopSyncManager } from "./sync-manager";

function fireFocus() {
  // Snapshot: handlers may unlisten (splice) mid-dispatch.
  // eslint-disable-next-line unicorn/no-useless-spread
  for (const h of [...focusHandlers]) h();
}

describe("diff-sync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    storeState = {
      worktreePath: "/repo",
      fileStatuses: [],
      selectedFile: null,
      selectedView: "changes",
      isViewingStaged: false,
      loadStatus,
      loadCommits,
      loadBehindCount,
      loadWorkingDiff,
    };
    nextFileStatuses = null;
    loadStatus.mockClear();
    loadCommits.mockClear();
    loadBehindCount.mockClear();
    loadWorkingDiff.mockClear();
    mockAddEventListener.mockClear();
    mockRemoveEventListener.mockClear();
    focusHandlers.length = 0;
  });

  afterEach(() => {
    disposeDiffSync();
    stopSyncManager();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("registers status and commits jobs and runs them on tick", async () => {
    initDiffSync();
    startSyncManager({ runImmediately: true });
    await vi.runOnlyPendingTimersAsync();

    expect(loadStatus).toHaveBeenCalledTimes(1);
    expect(loadCommits).toHaveBeenCalledTimes(1);
    expect(loadBehindCount).toHaveBeenCalledTimes(1);
  });

  it("skips job work when no worktreePath is set", async () => {
    storeState.worktreePath = "";
    initDiffSync();
    startSyncManager({ runImmediately: true });
    await vi.runOnlyPendingTimersAsync();

    expect(loadStatus).not.toHaveBeenCalled();
    expect(loadCommits).not.toHaveBeenCalled();
    expect(loadBehindCount).not.toHaveBeenCalled();
  });

  it("fires jobs on window focus", async () => {
    initDiffSync();
    startSyncManager({ runImmediately: false });

    fireFocus();
    await vi.runOnlyPendingTimersAsync();

    expect(loadStatus).toHaveBeenCalled();
    expect(loadCommits).toHaveBeenCalled();
    expect(loadBehindCount).toHaveBeenCalled();
  });

  it("runJobNow dedups against an already-running job via sync-manager guard", async () => {
    let resolveFirst: (() => void) | undefined;
    loadStatus.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = () => resolve();
        }),
    );

    initDiffSync();
    runJobNow(DIFF_STATUS_JOB_KEY);
    runJobNow(DIFF_STATUS_JOB_KEY);

    expect(loadStatus).toHaveBeenCalledTimes(1);

    resolveFirst?.();
    await vi.runOnlyPendingTimersAsync();
  });

  it("disposeDiffSync unregisters jobs and removes focus listener", async () => {
    initDiffSync();
    disposeDiffSync();

    runJobNow(DIFF_STATUS_JOB_KEY);
    runJobNow(DIFF_COMMITS_JOB_KEY);
    await vi.runOnlyPendingTimersAsync();
    expect(loadStatus).not.toHaveBeenCalled();
    expect(loadCommits).not.toHaveBeenCalled();

    expect(focusHandlers.length).toBe(0);
    expect(mockRemoveEventListener).toHaveBeenCalledWith("focus", expect.any(Function));
  });

  it("refreshes selected working diff when fileStatuses reference changes", async () => {
    storeState.selectedFile = "foo.ts";
    storeState.selectedView = "changes";
    storeState.fileStatuses = [{ path: "foo.ts" }];

    initDiffSync();

    // Next loadStatus returns a fresh list (new reference) → triggers diff reload
    nextFileStatuses = [{ path: "foo.ts" }, { path: "bar.ts" }];
    runJobNow(DIFF_STATUS_JOB_KEY);
    await vi.runOnlyPendingTimersAsync();
    expect(loadWorkingDiff).toHaveBeenCalledWith("foo.ts", false);

    // No new list → reference unchanged → no diff reload
    loadWorkingDiff.mockClear();
    runJobNow(DIFF_STATUS_JOB_KEY);
    await vi.runOnlyPendingTimersAsync();
    expect(loadWorkingDiff).not.toHaveBeenCalled();
  });

  it("does not refresh working diff when viewing a commit, even if fileStatuses changed", async () => {
    storeState.selectedFile = "foo.ts";
    storeState.selectedView = { hash: "abc" };
    storeState.fileStatuses = [{ path: "foo.ts" }];

    initDiffSync();
    nextFileStatuses = [{ path: "foo.ts" }, { path: "bar.ts" }];
    runJobNow(DIFF_STATUS_JOB_KEY);
    await vi.runOnlyPendingTimersAsync();

    expect(loadWorkingDiff).not.toHaveBeenCalled();
  });

  it("does not refresh working diff when no file is selected", async () => {
    storeState.selectedFile = null;
    storeState.fileStatuses = [{ path: "foo.ts" }];

    initDiffSync();
    nextFileStatuses = [{ path: "foo.ts" }, { path: "bar.ts" }];
    runJobNow(DIFF_STATUS_JOB_KEY);
    await vi.runOnlyPendingTimersAsync();

    expect(loadWorkingDiff).not.toHaveBeenCalled();
  });

  it("passes staged flag to loadWorkingDiff when isViewingStaged is true", async () => {
    storeState.selectedFile = "foo.ts";
    storeState.selectedView = "changes";
    storeState.isViewingStaged = true;
    storeState.fileStatuses = [{ path: "foo.ts" }];

    initDiffSync();
    nextFileStatuses = [{ path: "foo.ts" }, { path: "bar.ts" }];
    runJobNow(DIFF_STATUS_JOB_KEY);
    await vi.runOnlyPendingTimersAsync();

    expect(loadWorkingDiff).toHaveBeenCalledWith("foo.ts", true);
  });
});
