import { create } from "zustand";
import type { WorkspaceFileContent } from "../types";
import { readWorkspaceFile, revealInFinder } from "../lib/platform";
import { runCommand, runCommandSafely } from "../lib/command";
import { useTabStore, selectTabsForWorktree } from "./tab";

export type FileViewerStatus = "idle" | "loading" | "loaded" | "error";

export interface FileViewerTabState {
  rootPath: string;
  path: string;
  name: string;
  status: FileViewerStatus;
  data: WorkspaceFileContent | null;
  error: string | null;
}

export interface OpenFileArgs {
  rootPath: string;
  path: string;
  name: string;
}

interface FileViewerState {
  filesByTab: Record<string, FileViewerTabState>;
  openFile: (args: OpenFileArgs) => void;
  load: (tabId: string) => Promise<void>;
  reload: (tabId: string) => Promise<void>;
  removeTab: (tabId: string) => void;
}

function joinPath(rootPath: string, filePath: string): string {
  return `${rootPath.replace(/\/$/, "")}/${filePath}`;
}

export const useFileViewerStore = create<FileViewerState>((set, get) => ({
  filesByTab: {},

  openFile: ({ rootPath, path, name }) => {
    const tabState = useTabStore.getState();

    // Tabs are per-worktree; without an active worktree a file tab can't
    // persist, so fall back to revealing the file in Finder instead.
    if (tabState.activeWorktree == null) {
      void runCommandSafely(() => revealInFinder(joinPath(rootPath, path)), {
        errorToast: "Failed to reveal file in Finder",
      });
      return;
    }

    // Dedupe: reuse an existing tab only if it still belongs to the current
    // worktree session (tab ids are unique across sessions, but the entry
    // survives until removeTab, so guard against a stale cross-session match).
    const currentTabIds = new Set(
      selectTabsForWorktree(tabState, tabState.activeWorktree).map((tab) => tab.id),
    );
    const existing = Object.entries(get().filesByTab).find(
      ([tabId, entry]) =>
        entry.rootPath === rootPath && entry.path === path && currentTabIds.has(tabId),
    );
    if (existing) {
      useTabStore.getState().setActiveTab(existing[0]);
      return;
    }

    const id = useTabStore.getState().addTab("file", name);
    set((state) => ({
      filesByTab: {
        ...state.filesByTab,
        [id]: { rootPath, path, name, status: "idle", data: null, error: null },
      },
    }));
    void get().load(id);
  },

  load: async (tabId) => {
    const entry = get().filesByTab[tabId];
    if (!entry) return;

    set((state) => ({
      filesByTab: {
        ...state.filesByTab,
        [tabId]: { ...state.filesByTab[tabId], status: "loading", error: null },
      },
    }));

    try {
      const data = await runCommand(() => readWorkspaceFile(entry.rootPath, entry.path), {
        errorToast: false,
      });
      // The tab may have been closed mid-flight.
      if (!get().filesByTab[tabId]) return;
      set((state) => ({
        filesByTab: {
          ...state.filesByTab,
          [tabId]: { ...state.filesByTab[tabId], status: "loaded", data, error: null },
        },
      }));
    } catch (error) {
      if (!get().filesByTab[tabId]) return;
      const message = error instanceof Error ? error.message : "Failed to read file";
      set((state) => ({
        filesByTab: {
          ...state.filesByTab,
          [tabId]: { ...state.filesByTab[tabId], status: "error", error: message },
        },
      }));
    }
  },

  reload: async (tabId) => {
    await get().load(tabId);
  },

  removeTab: (tabId) =>
    set((state) => {
      if (!state.filesByTab[tabId]) return {};
      const filesByTab = { ...state.filesByTab };
      delete filesByTab[tabId];
      return { filesByTab };
    }),
}));

export function selectFileViewerTab(tabId: string) {
  return (state: FileViewerState): FileViewerTabState | null => state.filesByTab[tabId] ?? null;
}
