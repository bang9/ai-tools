import { loadJsonState, saveJsonState } from "./ui-state-storage";

const STORAGE_KEY = "grove.fileBrowserUi.v1";
const MAX_ROOTS = 30;

export interface FileBrowserUiState {
  expandedPaths: string[];
  selectedPath: string | null;
  lastUsed: number;
}

type FileBrowserUiMap = Record<string, FileBrowserUiState>;

function loadMap(): FileBrowserUiMap {
  const raw = loadJsonState<FileBrowserUiMap>(STORAGE_KEY);
  if (!raw || typeof raw !== "object") return {};
  return raw;
}

export function loadFileBrowserUiState(rootPath: string): FileBrowserUiState | null {
  const entry = loadMap()[rootPath];
  if (!entry || !Array.isArray(entry.expandedPaths)) return null;
  return {
    expandedPaths: entry.expandedPaths.filter((path): path is string => typeof path === "string"),
    selectedPath: typeof entry.selectedPath === "string" ? entry.selectedPath : null,
    lastUsed: typeof entry.lastUsed === "number" ? entry.lastUsed : 0,
  };
}

export function saveFileBrowserUiState(
  rootPath: string,
  expandedPaths: Iterable<string>,
  selectedPath: string | null,
): void {
  const map = loadMap();
  map[rootPath] = {
    expandedPaths: [...expandedPaths],
    selectedPath,
    lastUsed: Date.now(),
  };

  // Evict least-recently-used roots so the map can't grow unbounded.
  const roots = Object.keys(map);
  if (roots.length > MAX_ROOTS) {
    roots
      .sort((left, right) => (map[left].lastUsed ?? 0) - (map[right].lastUsed ?? 0))
      .slice(0, roots.length - MAX_ROOTS)
      .forEach((root) => delete map[root]);
  }

  saveJsonState(STORAGE_KEY, map);
}
