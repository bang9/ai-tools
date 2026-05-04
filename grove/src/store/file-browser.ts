import { create } from "zustand";
import type { DirectoryFileEntry } from "../types";
import * as platform from "../lib/platform";
import { runCommandSafely } from "../lib/command";

function entriesEqual(
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

interface FileBrowserState {
  worktreePath: string | null;
  entries: DirectoryFileEntry[];
  loaded: boolean;
  loading: boolean;
  setWorktreePath: (path: string | null) => void;
  loadDirectoryFiles: () => Promise<void>;
}

export const useFileBrowserStore = create<FileBrowserState>((set, get) => ({
  worktreePath: null,
  entries: [],
  loaded: false,
  loading: false,

  setWorktreePath: (path) => {
    if (path === get().worktreePath) return;
    set({
      worktreePath: path,
      entries: [],
      loaded: false,
      loading: false,
    });
  },

  loadDirectoryFiles: async () => {
    const wp = get().worktreePath;
    if (!wp) return;
    set({ loading: true });
    const next = await runCommandSafely(() => platform.listDirectoryFiles(wp), {
      errorToast: false,
    });
    if (get().worktreePath !== wp) return;
    if (!next) {
      set({ loading: false, loaded: true });
      return;
    }
    if (entriesEqual(get().entries, next)) {
      set({ loading: false, loaded: true });
      return;
    }
    set({ entries: next, loading: false, loaded: true });
  },
}));
