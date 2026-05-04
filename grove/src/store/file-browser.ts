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
  rootPath: string | null;
  entriesByParent: Record<string, DirectoryFileEntry[]>;
  loadedParents: Record<string, boolean>;
  loadingParents: Record<string, boolean>;
  setRootPath: (path: string | null) => void;
  loadChildren: (parentPath?: string | null) => Promise<void>;
}

const ROOT_PARENT = "";

function parentKey(parentPath?: string | null): string {
  return parentPath?.replace(/^\/+|\/+$/g, "") ?? ROOT_PARENT;
}

export const useFileBrowserStore = create<FileBrowserState>((set, get) => ({
  rootPath: null,
  entriesByParent: {},
  loadedParents: {},
  loadingParents: {},

  setRootPath: (path) => {
    if (path === get().rootPath) return;
    set({
      rootPath: path,
      entriesByParent: {},
      loadedParents: {},
      loadingParents: {},
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
      return;
    }

    set((state) => ({
      entriesByParent: { ...state.entriesByParent, [key]: next },
      loadedParents: { ...state.loadedParents, [key]: true },
      loadingParents: { ...state.loadingParents, [key]: false },
    }));
  },
}));
