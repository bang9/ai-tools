import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/platform", () => ({
  listDirectoryFiles: vi.fn(),
}));

vi.mock("../lib/command", () => ({
  runCommandSafely: vi.fn(),
}));

import * as platform from "../lib/platform";
import { runCommandSafely } from "../lib/command";
import type { DirectoryFileEntry } from "../types";
import { useFileBrowserStore } from "./file-browser";

describe("useFileBrowserStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFileBrowserStore.setState({
      rootPath: "/tmp/repo",
      entriesByParent: {},
      loadedParents: {},
      loadingParents: {},
    });
    vi.mocked(runCommandSafely).mockImplementation(
      async (action: () => Promise<unknown>) => action() as Promise<null>,
    );
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

  it("resets entries when the root changes", () => {
    useFileBrowserStore.setState({
      entriesByParent: {
        "": [
          { path: "src", name: "src", entryType: "directory", depth: 0 },
        ],
      },
      loadedParents: {
        "": true,
      },
      loadingParents: {
        src: true,
      },
    });

    useFileBrowserStore.getState().setRootPath("/tmp/other");

    expect(useFileBrowserStore.getState().entriesByParent).toEqual({});
    expect(useFileBrowserStore.getState().loadedParents).toEqual({});
    expect(useFileBrowserStore.getState().loadingParents).toEqual({});
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
});
