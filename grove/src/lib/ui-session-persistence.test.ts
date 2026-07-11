import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./platform", () => ({
  readWorkspaceFile: vi.fn(),
  revealInFinder: vi.fn(),
  loadUiState: vi.fn(),
  saveUiState: vi.fn(),
}));

vi.mock("./command", () => ({
  runCommand: vi.fn(),
  runCommandSafely: vi.fn(),
}));

import { initUiSessionPersistence } from "./ui-session-persistence";
import { primeUiStateCacheForTests, readUiStateCacheForTests } from "./ui-state-storage";
import { useTabStore, selectTabsForWorktree } from "../store/tab";
import { useBrowserStore } from "../store/browser";
import { useFileViewerStore } from "../store/file-viewer";
import { useRightPanelStore } from "../store/right-panel";

const TAB_SESSIONS_KEY = "grove.tabSessions.v1";
const BROWSER_NAVS_KEY = "grove.browserNavs.v1";
const FILE_VIEWER_TABS_KEY = "grove.fileViewerTabs.v1";
const RIGHT_PANEL_MODE_KEY = "grove.rightPanelMode.v1";

describe("initUiSessionPersistence", () => {
  beforeEach(() => {
    primeUiStateCacheForTests({});
    useTabStore.setState({ sessions: {}, activeWorktree: null });
    useBrowserStore.setState({ navs: {} });
    useFileViewerStore.setState({ filesByTab: {} });
    useRightPanelStore.setState({ mode: "commits" });
  });

  it("rehydrates sessions with companion state", () => {
    primeUiStateCacheForTests({
      [TAB_SESSIONS_KEY]: {
        "/tmp/wt": {
          tabs: [
            { id: "f-1", type: "file", title: "readme.md" },
            { id: "b-1", type: "browser", title: "localhost:3000" },
          ],
          activeTabId: "f-1",
        },
      },
      [FILE_VIEWER_TABS_KEY]: {
        "f-1": { rootPath: "/tmp/wt", path: "readme.md", name: "readme.md" },
        orphan: { rootPath: "/tmp/gone", path: "x", name: "x" },
      },
      [BROWSER_NAVS_KEY]: {
        "b-1": { url: "http://localhost:3000/", title: "Dev" },
        orphan: { url: "http://example.com/", title: null },
      },
    });

    initUiSessionPersistence();

    const tabs = selectTabsForWorktree(useTabStore.getState(), "/tmp/wt");
    expect(tabs.map((tab) => tab.id)).toEqual(["f-1", "b-1"]);
    expect(useTabStore.getState().sessions["/tmp/wt"].activeTabId).toBe("f-1");

    const fileEntry = useFileViewerStore.getState().filesByTab["f-1"];
    expect(fileEntry).toMatchObject({
      rootPath: "/tmp/wt",
      path: "readme.md",
      status: "idle",
      data: null,
    });
    expect(useFileViewerStore.getState().filesByTab.orphan).toBeUndefined();

    const nav = useBrowserStore.getState().navs["b-1"];
    expect(nav).toMatchObject({
      url: "http://localhost:3000/",
      title: "Dev",
      loading: false,
      history: ["http://localhost:3000/"],
      index: 0,
    });
    expect(useBrowserStore.getState().navs.orphan).toBeUndefined();
  });

  it("falls back to terminal when the persisted active tab is unknown", () => {
    primeUiStateCacheForTests({
      [TAB_SESSIONS_KEY]: {
        "/tmp/wt": {
          tabs: [{ id: "f-1", type: "file", title: "a.txt" }],
          activeTabId: "missing",
        },
      },
    });

    initUiSessionPersistence();

    expect(useTabStore.getState().sessions["/tmp/wt"].activeTabId).toBe("terminal");
  });

  it("persists later tab changes, dropping sessions with no closable tabs", () => {
    initUiSessionPersistence();

    useTabStore.getState().setActiveWorktree("/tmp/wt");
    vi.spyOn(crypto, "randomUUID").mockReturnValueOnce(
      "f-9" as `${string}-${string}-${string}-${string}-${string}`,
    );
    useTabStore.getState().addTab("file", "notes.md");

    const savedWithTab = readUiStateCacheForTests()[TAB_SESSIONS_KEY] as Record<
      string,
      { tabs: unknown[]; activeTabId: string }
    >;
    expect(savedWithTab["/tmp/wt"].tabs).toEqual([{ id: "f-9", type: "file", title: "notes.md" }]);
    expect(savedWithTab["/tmp/wt"].activeTabId).toBe("f-9");

    useTabStore.getState().closeTab("f-9");
    const savedAfterClose = readUiStateCacheForTests()[TAB_SESSIONS_KEY] as Record<string, unknown>;
    expect(savedAfterClose["/tmp/wt"]).toBeUndefined();
  });

  it("ignores malformed persisted payloads", () => {
    primeUiStateCacheForTests({ [TAB_SESSIONS_KEY]: "not an object" });

    initUiSessionPersistence();

    expect(useTabStore.getState().sessions).toEqual({});
  });

  it("persists the changes tab in display order and restores it", () => {
    primeUiStateCacheForTests({
      [TAB_SESSIONS_KEY]: {
        "/tmp/wt": {
          tabs: [
            { id: "b-1", type: "browser", title: "localhost:3000" },
            { id: "changes", type: "changes", title: "Changes" },
          ],
          activeTabId: "changes",
        },
      },
    });

    initUiSessionPersistence();

    const tabs = selectTabsForWorktree(useTabStore.getState(), "/tmp/wt");
    expect(tabs.map((tab) => tab.id)).toEqual(["b-1", "changes"]);
    expect(useTabStore.getState().sessions["/tmp/wt"].activeTabId).toBe("changes");

    // Round-trip: the snapshot keeps the same list and order.
    useTabStore.getState().setActiveWorktree("/tmp/wt");
    useTabStore.getState().setActiveTab("terminal");
    const saved = readUiStateCacheForTests()[TAB_SESSIONS_KEY] as Record<
      string,
      { tabs: { id: string }[]; activeTabId: string }
    >;
    expect(saved["/tmp/wt"].tabs.map((tab) => tab.id)).toEqual(["b-1", "changes"]);
    expect(saved["/tmp/wt"].activeTabId).toBe("terminal");
  });

  it("rehydrates and persists the right panel mode", () => {
    primeUiStateCacheForTests({ [RIGHT_PANEL_MODE_KEY]: "file-browser" });

    initUiSessionPersistence();
    expect(useRightPanelStore.getState().mode).toBe("file-browser");

    useRightPanelStore.getState().setMode("commits");
    expect(readUiStateCacheForTests()[RIGHT_PANEL_MODE_KEY]).toBe("commits");
  });

  it("ignores an invalid persisted right panel mode", () => {
    primeUiStateCacheForTests({ [RIGHT_PANEL_MODE_KEY]: "bogus" });

    initUiSessionPersistence();

    expect(useRightPanelStore.getState().mode).toBe("commits");
  });
});
