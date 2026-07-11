import { create } from "zustand";
import type { DirectoryFileEntry } from "../types";
import * as platform from "../lib/platform";
import { runCommandSafely } from "../lib/command";
import { loadFileBrowserUiState, saveFileBrowserUiState } from "../lib/file-browser-ui-persistence";

function entriesEqual(a: DirectoryFileEntry[], b: DirectoryFileEntry[]): boolean {
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

interface FileBrowserState {
  rootPath: string | null;
  entriesByParent: Record<string, DirectoryFileEntry[]>;
  loadedParents: Record<string, boolean>;
  loadingParents: Record<string, boolean>;
  expandedPaths: Set<string>;
  selectedPath: string | null;
  bulkLoading: boolean;
  refreshing: boolean;
  deepTruncated: boolean;
  setRootPath: (path: string | null) => void;
  loadChildren: (parentPath?: string | null) => Promise<void>;
  setSelectedPath: (path: string | null) => void;
  expandDirectory: (path: string) => void;
  collapseDirectory: (path: string) => void;
  collapseDirectoryDeep: (path: string) => void;
  toggleDirectory: (path: string) => void;
  expandAll: () => Promise<void>;
  collapseAll: () => void;
  refresh: () => Promise<void>;
}

const ROOT_PARENT = "";

function parentKey(parentPath?: string | null): string {
  return parentPath?.replace(/^\/+|\/+$/g, "") ?? ROOT_PARENT;
}

/** Parent key for an entry path — the segment before the last "/", or "" for top-level. */
function groupParentKey(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? ROOT_PARENT : path.slice(0, index);
}

export const useFileBrowserStore = create<FileBrowserState>((set, get) => ({
  rootPath: null,
  entriesByParent: {},
  loadedParents: {},
  loadingParents: {},
  expandedPaths: new Set(),
  selectedPath: null,
  bulkLoading: false,
  refreshing: false,
  deepTruncated: false,

  setRootPath: (path) => {
    if (path === get().rootPath) return;
    // Restore this root's persisted expansion/selection; loadChildren cascades
    // into restored-expanded directories as their parents load.
    const restored = path ? loadFileBrowserUiState(path) : null;
    set({
      rootPath: path,
      entriesByParent: {},
      loadedParents: {},
      loadingParents: {},
      expandedPaths: new Set(restored?.expandedPaths ?? []),
      selectedPath: restored?.selectedPath ?? null,
      bulkLoading: false,
      refreshing: false,
      deepTruncated: false,
    });
  },

  loadChildren: async (parentPath = ROOT_PARENT) => {
    const rootPath = get().rootPath;
    const key = parentKey(parentPath);
    if (!rootPath || get().loadedParents[key] || get().loadingParents[key]) return;

    set((state) => ({
      loadingParents: { ...state.loadingParents, [key]: true },
    }));

    const next = await runCommandSafely(() => platform.listDirectoryFiles(rootPath, key), {
      errorToast: false,
    });
    if (get().rootPath !== rootPath) return;

    if (!next) {
      set((state) => ({
        loadedParents: { ...state.loadedParents, [key]: true },
        loadingParents: { ...state.loadingParents, [key]: false },
      }));
      return;
    }

    if (entriesEqual(get().entriesByParent[key] ?? [], next)) {
      set((state) => ({
        loadedParents: { ...state.loadedParents, [key]: true },
        loadingParents: { ...state.loadingParents, [key]: false },
      }));
    } else {
      set((state) => ({
        entriesByParent: { ...state.entriesByParent, [key]: next },
        loadedParents: { ...state.loadedParents, [key]: true },
        loadingParents: { ...state.loadingParents, [key]: false },
      }));
    }

    // Cascade into expanded-but-unloaded subdirectories (restored expansion
    // after a restart, or expansion pruned back in by refresh).
    const { expandedPaths, loadedParents, loadingParents } = get();
    for (const entry of get().entriesByParent[key] ?? []) {
      if (
        entry.entryType === "directory" &&
        expandedPaths.has(entry.path) &&
        !loadedParents[entry.path] &&
        !loadingParents[entry.path]
      ) {
        void get().loadChildren(entry.path);
      }
    }
  },

  setSelectedPath: (path) => set({ selectedPath: path }),

  expandDirectory: (path) => {
    const current = get().expandedPaths;
    if (!current.has(path)) {
      const next = new Set(current);
      next.add(path);
      set({ expandedPaths: next });
    }
    void get().loadChildren(path);
  },

  collapseDirectory: (path) => {
    const current = get().expandedPaths;
    if (!current.has(path)) return;
    const next = new Set(current);
    next.delete(path);
    set({ expandedPaths: next });
  },

  collapseDirectoryDeep: (path) => {
    const current = get().expandedPaths;
    const prefix = `${path}/`;
    let changed = false;
    const next = new Set<string>();
    for (const candidate of current) {
      if (candidate === path || candidate.startsWith(prefix)) {
        changed = true;
        continue;
      }
      next.add(candidate);
    }
    if (changed) set({ expandedPaths: next });
  },

  toggleDirectory: (path) => {
    if (get().expandedPaths.has(path)) {
      get().collapseDirectory(path);
    } else {
      get().expandDirectory(path);
    }
  },

  expandAll: async () => {
    const rootPath = get().rootPath;
    if (!rootPath) return;

    set({ bulkLoading: true });

    const listing = await runCommandSafely(() => platform.listDirectoryFilesDeep(rootPath), {
      errorToast: false,
    });
    if (get().rootPath !== rootPath) return;

    if (!listing) {
      set({ bulkLoading: false });
      return;
    }

    const entriesByParent: Record<string, DirectoryFileEntry[]> = {};
    const loadedParents: Record<string, boolean> = { [ROOT_PARENT]: true };
    const expandedPaths = new Set<string>();

    for (const entry of listing.entries) {
      const parent = groupParentKey(entry.path);
      (entriesByParent[parent] ??= []).push(entry);
      if (entry.entryType === "directory") {
        loadedParents[entry.path] = true;
        expandedPaths.add(entry.path);
      }
    }

    set({
      entriesByParent,
      loadedParents,
      loadingParents: {},
      expandedPaths,
      deepTruncated: listing.truncated,
      bulkLoading: false,
    });
  },

  collapseAll: () => set({ expandedPaths: new Set() }),

  refresh: async () => {
    const rootPath = get().rootPath;
    if (!rootPath) return;

    const snapshot = [ROOT_PARENT, ...get().expandedPaths];
    set({ refreshing: true });

    const results = await Promise.all(
      snapshot.map(async (parent) => {
        const entries = await runCommandSafely(
          () => platform.listDirectoryFiles(rootPath, parent),
          { errorToast: false },
        );
        return { parent, entries };
      }),
    );
    if (get().rootPath !== rootPath) return;

    const refreshed = new Map<string, DirectoryFileEntry[]>();
    for (const { parent, entries } of results) {
      if (entries) refreshed.set(parent, entries);
    }

    const existingDirs = new Set<string>();
    for (const entries of refreshed.values()) {
      for (const entry of entries) {
        if (entry.entryType === "directory") existingDirs.add(entry.path);
      }
    }

    const isValidParent = (parent: string): boolean => {
      if (parent === ROOT_PARENT) return true;
      let acc = "";
      for (const segment of parent.split("/")) {
        acc = acc === "" ? segment : `${acc}/${segment}`;
        if (!existingDirs.has(acc)) return false;
      }
      return true;
    };

    const entriesByParent: Record<string, DirectoryFileEntry[]> = {};
    const loadedParents: Record<string, boolean> = {};
    for (const [parent, entries] of refreshed) {
      if (!isValidParent(parent)) continue;
      entriesByParent[parent] = entries;
      loadedParents[parent] = true;
    }

    const allPaths = new Set<string>();
    for (const entries of Object.values(entriesByParent)) {
      for (const entry of entries) allPaths.add(entry.path);
    }

    const nextExpanded = new Set<string>();
    for (const path of get().expandedPaths) {
      if (existingDirs.has(path)) nextExpanded.add(path);
    }

    const selectedPath = get().selectedPath;
    const nextSelected = selectedPath && allPaths.has(selectedPath) ? selectedPath : null;

    set({
      entriesByParent,
      loadedParents,
      loadingParents: {},
      expandedPaths: nextExpanded,
      selectedPath: nextSelected,
      refreshing: false,
    });
  },
}));

// Persist expansion/selection per root so the tree survives app restarts.
// setRootPath writes the restored state in the same set(), so this write-back
// is idempotent and never clobbers another root's saved state.
useFileBrowserStore.subscribe((state, previous) => {
  if (!state.rootPath) return;
  if (
    state.rootPath === previous.rootPath &&
    state.expandedPaths === previous.expandedPaths &&
    state.selectedPath === previous.selectedPath
  ) {
    return;
  }
  saveFileBrowserUiState(state.rootPath, state.expandedPaths, state.selectedPath);
});
