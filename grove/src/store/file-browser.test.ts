import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/platform", () => ({
  listDirectoryFiles: vi.fn(),
  listDirectoryFilesDeep: vi.fn(),
}));

vi.mock("../lib/command", () => ({
  runCommandSafely: vi.fn(),
}));

import * as platform from "../lib/platform";
import { runCommandSafely } from "../lib/command";
import type { DirectoryFileEntry } from "../types";
import { primeUiStateCacheForTests, readUiStateCacheForTests } from "../lib/ui-state-storage";
import { useFileBrowserStore } from "./file-browser";

function dir(path: string, depth: number): DirectoryFileEntry {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return { path, name, entryType: "directory", depth };
}

function file(path: string, depth: number): DirectoryFileEntry {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return { path, name, entryType: "file", depth };
}

describe("useFileBrowserStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFileBrowserStore.setState({
      rootPath: "/tmp/repo",
      entriesByParent: {},
      loadedParents: {},
      loadingParents: {},
      expandedPaths: new Set(),
      selectedPath: null,
      bulkLoading: false,
      refreshing: false,
      deepTruncated: false,
    });
    vi.mocked(runCommandSafely).mockImplementation(async (action: () => Promise<unknown>) => {
      try {
        return (await action()) as null;
      } catch {
        return null;
      }
    });
    vi.mocked(platform.listDirectoryFiles).mockResolvedValue([
      { path: "src", name: "src", entryType: "directory", depth: 0 },
      { path: "src/main.ts", name: "main.ts", entryType: "file", depth: 1 },
    ]);
  });

  it("loads file browser children for the current root", async () => {
    await useFileBrowserStore.getState().loadChildren();

    expect(platform.listDirectoryFiles).toHaveBeenCalledWith("/tmp/repo", "");
    expect(useFileBrowserStore.getState().entriesByParent[""]).toEqual([
      { path: "src", name: "src", entryType: "directory", depth: 0 },
      { path: "src/main.ts", name: "main.ts", entryType: "file", depth: 1 },
    ]);
    expect(useFileBrowserStore.getState().loadedParents[""]).toBe(true);
    expect(useFileBrowserStore.getState().loadingParents[""]).toBe(false);
  });

  it("loads children lazily per parent path", async () => {
    await useFileBrowserStore.getState().loadChildren("src");

    expect(platform.listDirectoryFiles).toHaveBeenCalledWith("/tmp/repo", "src");
    expect(useFileBrowserStore.getState().loadedParents.src).toBe(true);
  });

  it("skips already loaded parents", async () => {
    useFileBrowserStore.setState({
      loadedParents: { src: true },
    });

    await useFileBrowserStore.getState().loadChildren("src");

    expect(platform.listDirectoryFiles).not.toHaveBeenCalled();
  });

  it("resets entries, expansion, and selection when the root changes", () => {
    useFileBrowserStore.setState({
      entriesByParent: {
        "": [{ path: "src", name: "src", entryType: "directory", depth: 0 }],
      },
      loadedParents: {
        "": true,
      },
      loadingParents: {
        src: true,
      },
      expandedPaths: new Set(["src"]),
      selectedPath: "src",
      deepTruncated: true,
    });

    useFileBrowserStore.getState().setRootPath("/tmp/other");

    expect(useFileBrowserStore.getState().entriesByParent).toEqual({});
    expect(useFileBrowserStore.getState().loadedParents).toEqual({});
    expect(useFileBrowserStore.getState().loadingParents).toEqual({});
    expect(useFileBrowserStore.getState().expandedPaths.size).toBe(0);
    expect(useFileBrowserStore.getState().selectedPath).toBeNull();
    expect(useFileBrowserStore.getState().deepTruncated).toBe(false);
  });

  it("keeps cached entries when response is unchanged", async () => {
    const entries: DirectoryFileEntry[] = [
      { path: "src", name: "src", entryType: "directory", depth: 0 },
    ];
    useFileBrowserStore.setState({
      entriesByParent: { "": entries },
    });
    vi.mocked(platform.listDirectoryFiles).mockResolvedValue(entries);

    await useFileBrowserStore.getState().loadChildren();

    expect(useFileBrowserStore.getState().entriesByParent[""]).toBe(entries);
  });

  it("expandAll groups entries by parent and expands every directory", async () => {
    vi.mocked(platform.listDirectoryFilesDeep).mockResolvedValue({
      entries: [
        dir("src", 0),
        file("src/main.ts", 1),
        dir("src/utils", 1),
        file("src/utils/helper.ts", 2),
        file("README.md", 0),
      ],
      truncated: false,
    });

    await useFileBrowserStore.getState().expandAll();

    const state = useFileBrowserStore.getState();
    expect(platform.listDirectoryFilesDeep).toHaveBeenCalledWith("/tmp/repo");
    expect(state.entriesByParent[""]).toEqual([dir("src", 0), file("README.md", 0)]);
    expect(state.entriesByParent.src).toEqual([file("src/main.ts", 1), dir("src/utils", 1)]);
    expect(state.entriesByParent["src/utils"]).toEqual([file("src/utils/helper.ts", 2)]);
    expect(state.loadedParents).toEqual({ "": true, src: true, "src/utils": true });
    expect([...state.expandedPaths].sort()).toEqual(["src", "src/utils"]);
    expect(state.deepTruncated).toBe(false);
    expect(state.bulkLoading).toBe(false);
  });

  it("expandAll records the truncated flag", async () => {
    vi.mocked(platform.listDirectoryFilesDeep).mockResolvedValue({
      entries: [dir("src", 0)],
      truncated: true,
    });

    await useFileBrowserStore.getState().expandAll();

    expect(useFileBrowserStore.getState().deepTruncated).toBe(true);
  });

  it("collapseAll clears expansion but keeps cached entries", () => {
    const entries = { "": [dir("src", 0)], src: [file("src/main.ts", 1)] };
    useFileBrowserStore.setState({
      entriesByParent: entries,
      loadedParents: { "": true, src: true },
      expandedPaths: new Set(["src"]),
    });

    useFileBrowserStore.getState().collapseAll();

    const state = useFileBrowserStore.getState();
    expect(state.expandedPaths.size).toBe(0);
    expect(state.entriesByParent).toBe(entries);
    expect(state.loadedParents).toEqual({ "": true, src: true });
  });

  it("refresh preserves expansion and selection", async () => {
    useFileBrowserStore.setState({
      entriesByParent: { "": [dir("src", 0)], src: [file("src/main.ts", 1)] },
      loadedParents: { "": true, src: true },
      expandedPaths: new Set(["src"]),
      selectedPath: "src/main.ts",
    });
    vi.mocked(platform.listDirectoryFiles).mockImplementation(async (_root, parent) => {
      if (parent === "") return [dir("src", 0)];
      if (parent === "src") return [file("src/main.ts", 1)];
      return [];
    });

    await useFileBrowserStore.getState().refresh();

    const state = useFileBrowserStore.getState();
    expect(platform.listDirectoryFiles).toHaveBeenCalledWith("/tmp/repo", "");
    expect(platform.listDirectoryFiles).toHaveBeenCalledWith("/tmp/repo", "src");
    expect(state.entriesByParent[""]).toEqual([dir("src", 0)]);
    expect(state.entriesByParent.src).toEqual([file("src/main.ts", 1)]);
    expect(state.loadedParents).toEqual({ "": true, src: true });
    expect([...state.expandedPaths]).toEqual(["src"]);
    expect(state.selectedPath).toBe("src/main.ts");
    expect(state.refreshing).toBe(false);
  });

  it("refresh prunes vanished directories from expansion and selection", async () => {
    useFileBrowserStore.setState({
      entriesByParent: {
        "": [dir("src", 0)],
        src: [dir("src/old", 1)],
        "src/old": [file("src/old/gone.ts", 2)],
      },
      loadedParents: { "": true, src: true, "src/old": true },
      expandedPaths: new Set(["src", "src/old"]),
      selectedPath: "src/old/gone.ts",
    });
    vi.mocked(platform.listDirectoryFiles).mockImplementation(async (_root, parent) => {
      if (parent === "") return [dir("src", 0)];
      if (parent === "src") return [file("src/main.ts", 1)];
      throw new Error("no such directory");
    });

    await useFileBrowserStore.getState().refresh();

    const state = useFileBrowserStore.getState();
    expect(state.entriesByParent["src/old"]).toBeUndefined();
    expect(state.entriesByParent.src).toEqual([file("src/main.ts", 1)]);
    expect([...state.expandedPaths]).toEqual(["src"]);
    expect(state.selectedPath).toBeNull();
    expect(state.loadedParents).toEqual({ "": true, src: true });
  });

  it("collapseDirectoryDeep collapses a directory and its expanded descendants", () => {
    useFileBrowserStore.setState({
      expandedPaths: new Set(["src", "src/utils", "src/utils/nested", "lib"]),
    });

    useFileBrowserStore.getState().collapseDirectoryDeep("src");

    expect([...useFileBrowserStore.getState().expandedPaths]).toEqual(["lib"]);
  });

  describe("persisted ui state", () => {
    const STORAGE_KEY = "grove.fileBrowserUi.v1";

    beforeEach(() => {
      primeUiStateCacheForTests({});
    });

    it("setRootPath restores persisted expansion and loadChildren cascades into it", async () => {
      primeUiStateCacheForTests({
        [STORAGE_KEY]: {
          "/tmp/other": {
            expandedPaths: ["src", "src/utils"],
            selectedPath: "src/utils/helper.ts",
            lastUsed: 1,
          },
        },
      });
      vi.mocked(platform.listDirectoryFiles).mockImplementation(async (_root, parent) => {
        if (parent === "") return [dir("src", 0)];
        if (parent === "src") return [dir("src/utils", 1), file("src/main.ts", 1)];
        if (parent === "src/utils") return [file("src/utils/helper.ts", 2)];
        throw new Error(`unexpected parent: ${parent}`);
      });

      useFileBrowserStore.getState().setRootPath("/tmp/other");
      expect([...useFileBrowserStore.getState().expandedPaths]).toEqual(["src", "src/utils"]);
      expect(useFileBrowserStore.getState().selectedPath).toBe("src/utils/helper.ts");

      await useFileBrowserStore.getState().loadChildren("");
      await vi.waitFor(() => {
        const state = useFileBrowserStore.getState();
        expect(state.loadedParents["src/utils"]).toBe(true);
      });
      expect(useFileBrowserStore.getState().entriesByParent["src/utils"]).toEqual([
        file("src/utils/helper.ts", 2),
      ]);
    });

    it("saves expansion and selection changes for the active root", () => {
      useFileBrowserStore.getState().setRootPath("/tmp/save-root");
      useFileBrowserStore.setState({ expandedPaths: new Set(["src"]) });
      useFileBrowserStore.getState().setSelectedPath("src/main.ts");

      const saved = readUiStateCacheForTests()[STORAGE_KEY] as Record<
        string,
        { expandedPaths: string[]; selectedPath: string | null }
      >;
      expect(saved["/tmp/save-root"].expandedPaths).toEqual(["src"]);
      expect(saved["/tmp/save-root"].selectedPath).toBe("src/main.ts");
    });
  });
});
