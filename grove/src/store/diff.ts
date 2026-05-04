import { create } from "zustand";
import type { FileStatus, CommitInfo, DirectoryFileEntry, FileDiff } from "../types";
import * as tauri from "../lib/platform";
import { runCommandSafely, runCommand } from "../lib/command";
import { useToastStore } from "../store/toast";

// Content-equality checks let polling calls skip `set()` when nothing
// changed, so Zustand subscribers don't re-render every 2s on identical
// data. Reference identity after a no-op set doubles as a change signal
// for lib/diff-sync.ts (see runStatusJob there).
function fileStatusesEqual(a: FileStatus[], b: FileStatus[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.path !== y.path || x.status !== y.status || x.staged !== y.staged) {
      return false;
    }
  }
  return true;
}

function commitsEqual(a: CommitInfo[], b: CommitInfo[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].hash !== b[i].hash) return false;
  }
  return true;
}

function directoryFilesEqual(
  a: DirectoryFileEntry[],
  b: DirectoryFileEntry[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.path !== y.path ||
      x.name !== y.name ||
      x.entryType !== y.entryType ||
      x.depth !== y.depth
    ) {
      return false;
    }
  }
  return true;
}

interface DiffState {
  commits: CommitInfo[];
  fileStatuses: FileStatus[];
  directoryFiles: DirectoryFileEntry[];
  directoryFilesLoaded: boolean;
  directoryFilesLoading: boolean;
  currentDiff: FileDiff | null;
  commitDiffs: FileDiff[];
  selectedView: "changes" | CommitInfo;
  selectedFile: string | null;
  isViewingStaged: boolean;
  selectedLines: Map<string, Set<number>>;
  worktreePath: string | null;
  behindCount: number;
  merging: boolean;

  setWorktreePath: (path: string | null) => void;
  loadStatus: () => Promise<void>;
  loadDirectoryFiles: () => Promise<void>;
  loadCommits: () => Promise<void>;
  loadBehindCount: () => Promise<void>;
  refreshAll: () => Promise<void>;
  mergeDefaultBranch: () => Promise<void>;
  loadWorkingDiff: (path: string, staged?: boolean) => Promise<void>;
  loadCommitDiff: (hash: string) => Promise<void>;
  selectView: (view: "changes" | CommitInfo) => void;
  selectFile: (path: string | null, staged?: boolean) => void;
  selectLine: (filePath: string, index: number) => void;
  toggleLine: (filePath: string, index: number) => void;
  selectLineRange: (filePath: string, start: number, end: number) => void;
  clearSelection: () => void;

  stageFile: (path: string) => Promise<void>;
  stageFiles: (paths: string[]) => Promise<void>;
  unstageFile: (path: string) => Promise<void>;
  unstageFiles: (paths: string[]) => Promise<void>;
  discardFile: (path: string) => Promise<void>;
  discardFiles: (paths: string[]) => Promise<void>;
  removeUntrackedFiles: (paths: string[]) => Promise<void>;
  stageHunk: (path: string, hunkIndex: number) => Promise<void>;
  unstageHunk: (path: string, hunkIndex: number) => Promise<void>;
  discardHunk: (path: string, hunkIndex: number) => Promise<void>;
  stageLines: (
    path: string,
    hunkIndex: number,
    lineIndices: number[],
  ) => Promise<void>;
  unstageLines: (
    path: string,
    hunkIndex: number,
    lineIndices: number[],
  ) => Promise<void>;
  discardLines: (
    path: string,
    hunkIndex: number,
    lineIndices: number[],
  ) => Promise<void>;
}

export const useDiffStore = create<DiffState>((set, get) => ({
  commits: [],
  fileStatuses: [],
  directoryFiles: [],
  directoryFilesLoaded: false,
  directoryFilesLoading: false,
  currentDiff: null,
  commitDiffs: [],
  selectedView: "changes",
  selectedFile: null,
  isViewingStaged: false,
  selectedLines: new Map(),
  worktreePath: null,
  behindCount: 0,
  merging: false,

  setWorktreePath: (path) => {
    if (path === get().worktreePath) return;
    set({
      worktreePath: path,
      fileStatuses: [],
      directoryFiles: [],
      directoryFilesLoaded: false,
      directoryFilesLoading: false,
      commits: [],
      currentDiff: null,
      commitDiffs: [],
      selectedView: "changes",
      selectedFile: null,
      isViewingStaged: false,
      selectedLines: new Map(),
      behindCount: 0,
    });
  },

  loadStatus: async () => {
    const wp = get().worktreePath;
    if (!wp) return;
    const next = await runCommandSafely(() => tauri.getStatus(wp), {
      errorToast: false,
    });
    if (!next) return;
    if (fileStatusesEqual(get().fileStatuses, next)) return;
    set({ fileStatuses: next });
  },

  loadDirectoryFiles: async () => {
    const wp = get().worktreePath;
    if (!wp) return;
    set({ directoryFilesLoading: true });
    const next = await runCommandSafely(() => tauri.listDirectoryFiles(wp), {
      errorToast: false,
    });
    if (get().worktreePath !== wp) return;
    if (!next) {
      set({ directoryFilesLoading: false, directoryFilesLoaded: true });
      return;
    }

    if (directoryFilesEqual(get().directoryFiles, next)) {
      set({ directoryFilesLoading: false, directoryFilesLoaded: true });
      return;
    }
    set({
      directoryFiles: next,
      directoryFilesLoading: false,
      directoryFilesLoaded: true,
    });
  },

  loadCommits: async () => {
    const wp = get().worktreePath;
    if (!wp) return;
    const next = await runCommandSafely(() => tauri.getCommits(wp, 50), {
      errorToast: false,
    });
    if (!next) return;
    if (commitsEqual(get().commits, next)) return;
    set({ commits: next });
  },

  loadBehindCount: async () => {
    const wp = get().worktreePath;
    if (!wp) return;
    const info = await runCommandSafely(() => tauri.getBehindCount(wp), {
      errorToast: false,
    });
    if (!info) return;
    if (get().behindCount === info.behind) return;
    set({ behindCount: info.behind });
  },

  refreshAll: async () => {
    const state = get();
    if (!state.worktreePath) return;
    await Promise.all([
      state.loadStatus(),
      state.loadCommits(),
      state.loadBehindCount(),
      state.directoryFilesLoaded
        ? state.loadDirectoryFiles()
        : Promise.resolve(),
    ]);
    // If a file is selected in changes view, keep its diff fresh too
    const after = get();
    if (after.selectedFile && after.selectedView === "changes") {
      await after.loadWorkingDiff(after.selectedFile, after.isViewingStaged);
    }
  },

  mergeDefaultBranch: async () => {
    const wp = get().worktreePath;
    if (!wp) return;
    set({ merging: true });
    try {
      await runCommand(() => tauri.mergeDefaultBranch(wp), {
        errorToast: "Merge conflict — resolve in terminal",
      });
      useToastStore.getState().addToast("success", "Merged default branch");
      await get().refreshAll();
    } catch {
      // Error toast already shown by runCommand
    } finally {
      set({ merging: false });
    }
  },

  loadWorkingDiff: async (path, staged = false) => {
    const wp = get().worktreePath;
    if (!wp) return;
    const queryPath = staged ? `staged:${path}` : path;
    const diff = await runCommandSafely(() => tauri.getWorkingDiff(wp, queryPath), {
      errorToast: false,
    });
    if (diff) {
      set({ currentDiff: diff, selectedLines: new Map() });
    } else {
      set({ currentDiff: null });
    }
  },

  loadCommitDiff: async (hash) => {
    const wp = get().worktreePath;
    if (!wp) return;
    const diffs = await runCommandSafely(() => tauri.getCommitDiff(wp, hash), {
      errorToast: false,
    });
    if (diffs) {
      set({
        commitDiffs: diffs,
        currentDiff: diffs[0] ?? null,
        selectedFile: diffs[0]?.path ?? null,
        selectedLines: new Map(),
      });
    } else {
      set({ currentDiff: null });
    }
  },

  selectView: (view) => {
    if (view === "changes") {
      set({
        selectedView: view,
        selectedFile: null,
        currentDiff: null,
        commitDiffs: [],
        selectedLines: new Map(),
      });
      // Auto-select first file
      const { fileStatuses } = get();
      if (fileStatuses.length > 0) {
        get().selectFile(fileStatuses[0].path, fileStatuses[0].staged);
      }
    } else {
      // Switch view immediately but keep previous data visible until load completes
      set({ selectedView: view, selectedLines: new Map() });
      get().loadCommitDiff(view.hash);
    }
  },

  selectFile: (path, staged = false) => {
    set({ selectedFile: path, isViewingStaged: staged, selectedLines: new Map() });
    if (path) {
      const state = get();
      if (state.selectedView === "changes") {
        state.loadWorkingDiff(path, staged);
      } else {
        // For commit view, find the diff from commitDiffs
        const diff = state.commitDiffs.find((d) => d.path === path);
        set({ currentDiff: diff ?? null });
      }
    } else {
      set({ currentDiff: null });
    }
  },

  selectLine: (filePath, index) => {
    const next = new Map(get().selectedLines);
    next.set(filePath, new Set([index]));
    set({ selectedLines: next });
  },

  toggleLine: (filePath, index) => {
    const prev = get().selectedLines;
    const next = new Map(prev);
    const fileSet = new Set(prev.get(filePath) ?? []);
    if (fileSet.has(index)) {
      fileSet.delete(index);
    } else {
      fileSet.add(index);
    }
    next.set(filePath, fileSet);
    set({ selectedLines: next });
  },

  selectLineRange: (filePath, start, end) => {
    const min = Math.min(start, end);
    const max = Math.max(start, end);
    const fileSet = new Set<number>();
    for (let i = min; i <= max; i++) {
      fileSet.add(i);
    }
    const next = new Map(get().selectedLines);
    next.set(filePath, fileSet);
    set({ selectedLines: next });
  },

  clearSelection: () => set({ selectedLines: new Map() }),

  // Refresh helpers
  ...createMutationActions(),
}));

function createMutationActions() {
  const runMutation = async (
    action: () => Promise<void>,
    errorToast: string,
  ) => {
    await runCommandSafely(action, { errorToast });
  };

  // Post-mutation refresh: stage/unstage/discard do not change commits or
  // behindCount, so this deliberately avoids `refreshAll()` to skip 2 extra
  // git calls per mutation. refreshAll is used for broader events (merge,
  // manual trigger, window focus) where commit history may have changed.
  const refresh = async () => {
    const state = useDiffStore.getState();
    state.clearSelection();
    await state.loadStatus();
    if (state.selectedFile && state.selectedView === "changes") {
      await state.loadWorkingDiff(state.selectedFile, state.isViewingStaged);
    }
  };

  return {
    stageFile: async (path: string) => {
      const wp = useDiffStore.getState().worktreePath;
      if (!wp) return;
      await runMutation(async () => {
        await tauri.stageFile(wp, path);
        await refresh();
      }, "Failed to stage file");
    },
    stageFiles: async (paths: string[]) => {
      const wp = useDiffStore.getState().worktreePath;
      if (!wp || paths.length === 0) return;
      await runMutation(async () => {
        await tauri.stageFiles(wp, paths);
        await refresh();
      }, "Failed to stage files");
    },
    unstageFile: async (path: string) => {
      const wp = useDiffStore.getState().worktreePath;
      if (!wp) return;
      await runMutation(async () => {
        await tauri.unstageFile(wp, path);
        await refresh();
      }, "Failed to unstage file");
    },
    unstageFiles: async (paths: string[]) => {
      const wp = useDiffStore.getState().worktreePath;
      if (!wp || paths.length === 0) return;
      await runMutation(async () => {
        await tauri.unstageFiles(wp, paths);
        await refresh();
      }, "Failed to unstage files");
    },
    discardFile: async (path: string) => {
      const wp = useDiffStore.getState().worktreePath;
      if (!wp) return;
      await runMutation(async () => {
        await tauri.discardFile(wp, path);
        await refresh();
      }, "Failed to discard file");
    },
    discardFiles: async (paths: string[]) => {
      const wp = useDiffStore.getState().worktreePath;
      if (!wp || paths.length === 0) return;
      await runMutation(async () => {
        await tauri.discardFiles(wp, paths);
        await refresh();
      }, "Failed to discard files");
    },
    removeUntrackedFiles: async (paths: string[]) => {
      const wp = useDiffStore.getState().worktreePath;
      if (!wp || paths.length === 0) return;
      await runMutation(async () => {
        await tauri.removeUntrackedFiles(wp, paths);
        await refresh();
      }, "Failed to remove files");
    },
    stageHunk: async (path: string, hunkIndex: number) => {
      const wp = useDiffStore.getState().worktreePath;
      if (!wp) return;
      await runMutation(async () => {
        await tauri.stageHunk(wp, path, hunkIndex);
        await refresh();
      }, "Failed to stage hunk");
    },
    unstageHunk: async (path: string, hunkIndex: number) => {
      const wp = useDiffStore.getState().worktreePath;
      if (!wp) return;
      await runMutation(async () => {
        await tauri.unstageHunk(wp, path, hunkIndex);
        await refresh();
      }, "Failed to unstage hunk");
    },
    discardHunk: async (path: string, hunkIndex: number) => {
      const wp = useDiffStore.getState().worktreePath;
      if (!wp) return;
      await runMutation(async () => {
        await tauri.discardHunk(wp, path, hunkIndex);
        await refresh();
      }, "Failed to discard hunk");
    },
    stageLines: async (
      path: string,
      hunkIndex: number,
      lineIndices: number[],
    ) => {
      const wp = useDiffStore.getState().worktreePath;
      if (!wp) return;
      await runMutation(async () => {
        await tauri.stageLines(wp, path, hunkIndex, lineIndices);
        await refresh();
      }, "Failed to stage selected lines");
    },
    unstageLines: async (
      path: string,
      hunkIndex: number,
      lineIndices: number[],
    ) => {
      const wp = useDiffStore.getState().worktreePath;
      if (!wp) return;
      await runMutation(async () => {
        await tauri.unstageLines(wp, path, hunkIndex, lineIndices);
        await refresh();
      }, "Failed to unstage selected lines");
    },
    discardLines: async (
      path: string,
      hunkIndex: number,
      lineIndices: number[],
    ) => {
      const wp = useDiffStore.getState().worktreePath;
      if (!wp) return;
      await runMutation(async () => {
        await tauri.discardLines(wp, path, hunkIndex, lineIndices);
        await refresh();
      }, "Failed to discard selected lines");
    },
  };
}
