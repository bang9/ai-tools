import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/platform", () => ({
  loadTerminalLayouts: vi.fn(),
  saveTerminalLayouts: vi.fn(),
}));

import {
  useTabStore,
  selectActiveTabIdForWorktree,
  selectCurrentActiveTabId,
  selectCurrentTabs,
  selectTabsForWorktree,
} from "./tab";
import { useBrowserStore } from "./browser";
import { useTerminalStore } from "./terminal";

function initWorktree(path = "/tmp/wt") {
  useTabStore.getState().setActiveWorktree(path);
}

describe("useTabStore", () => {
  beforeEach(() => {
    useTabStore.setState({ sessions: {}, activeWorktree: null });
    useBrowserStore.setState({ navs: {} });
  });

  it("initializes empty with the terminal content active", () => {
    initWorktree();
    const tabs = selectCurrentTabs(useTabStore.getState());
    const activeTabId = selectCurrentActiveTabId(useTabStore.getState());
    expect(tabs).toHaveLength(0);
    expect(activeTabId).toBe("terminal");
  });

  it("adds closable browser tab and activates it", () => {
    initWorktree();
    vi.spyOn(crypto, "randomUUID").mockReturnValueOnce(
      "uuid-1" as `${string}-${string}-${string}-${string}-${string}`,
    );
    const id = useTabStore.getState().addTab("browser", "Browser");
    const tabs = selectCurrentTabs(useTabStore.getState());
    expect(id).toBe("uuid-1");
    expect(tabs).toHaveLength(1);
    expect(selectCurrentActiveTabId(useTabStore.getState())).toBe("uuid-1");
  });

  it("addTab changes creates a closable singleton and re-activates it later", () => {
    initWorktree();
    const id = useTabStore.getState().addTab("changes", "Changes");
    expect(id).toBe("changes");
    expect(selectCurrentActiveTabId(useTabStore.getState())).toBe("changes");
    expect(selectCurrentTabs(useTabStore.getState())).toEqual([
      { id: "changes", type: "changes", title: "Changes", closable: true },
    ]);

    useTabStore.getState().setActiveTab("terminal");
    const again = useTabStore.getState().addTab("changes", "Changes");
    expect(again).toBe("changes");
    expect(selectCurrentActiveTabId(useTabStore.getState())).toBe("changes");
    expect(selectCurrentTabs(useTabStore.getState())).toHaveLength(1);
  });

  it("allows multiple browser tabs", () => {
    initWorktree();
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("b-1" as `${string}-${string}-${string}-${string}-${string}`)
      .mockReturnValueOnce("b-2" as `${string}-${string}-${string}-${string}-${string}`);
    useTabStore.getState().addTab("browser", "Browser 1");
    useTabStore.getState().addTab("browser", "Browser 2");
    expect(selectCurrentTabs(useTabStore.getState())).toHaveLength(2);
  });

  it("closes browser tab and falls back to terminal", () => {
    initWorktree();
    vi.spyOn(crypto, "randomUUID").mockReturnValueOnce(
      "b-1" as `${string}-${string}-${string}-${string}-${string}`,
    );
    useTabStore.getState().addTab("browser", "Browser");
    expect(selectCurrentActiveTabId(useTabStore.getState())).toBe("b-1");
    useTabStore.getState().closeTab("b-1");
    expect(selectCurrentTabs(useTabStore.getState())).toHaveLength(0);
    expect(selectCurrentActiveTabId(useTabStore.getState())).toBe("terminal");
  });

  it("closes the changes tab and falls back to terminal", () => {
    initWorktree();
    useTabStore.getState().addTab("changes", "Changes");
    useTabStore.getState().closeTab("changes");
    expect(selectCurrentTabs(useTabStore.getState())).toHaveLength(0);
    expect(selectCurrentActiveTabId(useTabStore.getState())).toBe("terminal");
  });

  it("closeTab with unknown id does nothing", () => {
    initWorktree();
    useTabStore.getState().closeTab("missing");
    expect(selectCurrentTabs(useTabStore.getState())).toHaveLength(0);
    expect(selectCurrentActiveTabId(useTabStore.getState())).toBe("terminal");
  });

  it("switches active tab, including the terminal sentinel without a tab entry", () => {
    initWorktree();
    useTabStore.getState().addTab("changes", "Changes");
    expect(selectCurrentActiveTabId(useTabStore.getState())).toBe("changes");
    useTabStore.getState().setActiveTab("terminal");
    expect(selectCurrentActiveTabId(useTabStore.getState())).toBe("terminal");
    useTabStore.getState().setActiveTab("changes");
    expect(selectCurrentActiveTabId(useTabStore.getState())).toBe("changes");
  });

  it("closing active browser tab activates previous tab", () => {
    initWorktree();
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("p-1" as `${string}-${string}-${string}-${string}-${string}`)
      .mockReturnValueOnce("p-2" as `${string}-${string}-${string}-${string}-${string}`);
    useTabStore.getState().addTab("browser", "B1");
    useTabStore.getState().addTab("browser", "B2");
    useTabStore.getState().closeTab("p-2");
    expect(selectCurrentActiveTabId(useTabStore.getState())).toBe("p-1");
  });

  it("closing the last closable tab lands on terminal", () => {
    initWorktree();
    vi.spyOn(crypto, "randomUUID").mockReturnValueOnce(
      "p-1" as `${string}-${string}-${string}-${string}-${string}`,
    );
    useTabStore.getState().addTab("browser", "B1");
    useTabStore.getState().closeTab("p-1");
    expect(selectCurrentActiveTabId(useTabStore.getState())).toBe("terminal");
  });

  it("setActiveTab with non-existent id does nothing", () => {
    initWorktree();
    useTabStore.getState().setActiveTab("non-existent");
    expect(selectCurrentActiveTabId(useTabStore.getState())).toBe("terminal");
  });

  describe("worktree isolation", () => {
    it("each worktree has independent tab state", () => {
      useTabStore.getState().setActiveWorktree("/tmp/a");
      vi.spyOn(crypto, "randomUUID").mockReturnValueOnce(
        "br-a" as `${string}-${string}-${string}-${string}-${string}`,
      );
      useTabStore.getState().addTab("browser", "Browser");
      expect(selectCurrentTabs(useTabStore.getState())).toHaveLength(1);

      useTabStore.getState().setActiveWorktree("/tmp/b");
      expect(selectCurrentTabs(useTabStore.getState())).toHaveLength(0);
      expect(selectCurrentActiveTabId(useTabStore.getState())).toBe("terminal");

      useTabStore.getState().setActiveWorktree("/tmp/a");
      expect(selectCurrentTabs(useTabStore.getState())).toHaveLength(1);
      expect(selectCurrentActiveTabId(useTabStore.getState())).toBe("br-a");
    });

    it("can read a selected worktree session before activeWorktree catches up", () => {
      useTabStore.getState().setActiveWorktree("/tmp/a");
      useTabStore.getState().addTab("changes", "Changes");

      useTabStore.getState().setActiveWorktree("/tmp/b");

      const state = useTabStore.getState();

      expect(selectActiveTabIdForWorktree(state, "/tmp/a")).toBe("changes");
      expect(selectActiveTabIdForWorktree(state, "/tmp/b")).toBe("terminal");
      expect(selectTabsForWorktree(state, "/tmp/a")).toHaveLength(1);
      expect(selectTabsForWorktree(state, "/tmp/b")).toHaveLength(0);
    });

    it("removeSession cleans up worktree tab state", () => {
      useTabStore.getState().setActiveWorktree("/tmp/a");
      useTabStore.getState().addTab("browser", "Browser");
      useTabStore.getState().removeSession("/tmp/a");
      expect(useTabStore.getState().sessions["/tmp/a"]).toBeUndefined();
    });
  });

  describe("updateTabTitle", () => {
    it("renames a closable tab", () => {
      initWorktree();
      const id = useTabStore.getState().addTab("browser", "Browser");
      useTabStore.getState().updateTabTitle(id, "localhost:3000");
      const tab = selectCurrentTabs(useTabStore.getState()).find((t) => t.id === id);
      expect(tab?.title).toBe("localhost:3000");
    });

    it("ignores unknown ids", () => {
      initWorktree();
      useTabStore.getState().updateTabTitle("missing", "Nope");
      expect(selectCurrentTabs(useTabStore.getState())).toHaveLength(0);
    });
  });

  describe("terminal tab entries", () => {
    it("syncTerminalTabs appends new terminal entries at the end in creation order", () => {
      initWorktree();
      useTabStore.getState().addTab("changes", "Changes");
      useTabStore.getState().syncTerminalTabs("/tmp/wt", ["t-1", "t-2"]);

      const tabs = selectCurrentTabs(useTabStore.getState());
      expect(tabs.map((t) => t.id)).toEqual(["changes", "t-1", "t-2"]);
      expect(tabs[1]).toMatchObject({ type: "terminal", closable: true });
    });

    it("syncTerminalTabs keeps positions of existing entries and drops stale ones", () => {
      initWorktree();
      useTabStore.getState().syncTerminalTabs("/tmp/wt", ["t-1"]);
      useTabStore.getState().addTab("changes", "Changes");
      useTabStore.getState().syncTerminalTabs("/tmp/wt", ["t-1", "t-2"]);
      expect(selectCurrentTabs(useTabStore.getState()).map((t) => t.id)).toEqual([
        "t-1",
        "changes",
        "t-2",
      ]);

      useTabStore.getState().syncTerminalTabs("/tmp/wt", ["t-2"]);
      expect(selectCurrentTabs(useTabStore.getState()).map((t) => t.id)).toEqual([
        "changes",
        "t-2",
      ]);
    });

    it("syncTerminalTabs(null) removes entries and moves active off the terminal sentinel", () => {
      initWorktree();
      useTabStore.getState().syncTerminalTabs("/tmp/wt", ["t-1"]);
      useTabStore.getState().addTab("changes", "Changes");
      useTabStore.getState().setActiveTab("terminal");

      useTabStore.getState().syncTerminalTabs("/tmp/wt", null);

      const state = useTabStore.getState();
      expect(selectCurrentTabs(state).map((t) => t.id)).toEqual(["changes"]);
      expect(selectCurrentActiveTabId(state)).toBe("changes");
    });

    it("closeTab ignores terminal entries — they close via closeTerminalTab", () => {
      initWorktree();
      useTabStore.getState().syncTerminalTabs("/tmp/wt", ["t-1"]);
      useTabStore.getState().closeTab("t-1");
      expect(selectCurrentTabs(useTabStore.getState()).map((t) => t.id)).toEqual(["t-1"]);
    });

    it("closing an active tab whose neighbor is a terminal entry activates that terminal tab", () => {
      initWorktree();
      useTerminalStore.setState({
        sessions: {
          "/tmp/wt": {
            tabs: [
              { id: "t-1", node: { id: "p-1", type: "leaf", ptyId: "pty-1" } },
              { id: "t-2", node: { id: "p-2", type: "leaf", ptyId: "pty-2" } },
            ],
            activeTabId: "t-2",
          },
        },
      });
      useTabStore.getState().syncTerminalTabs("/tmp/wt", ["t-1", "t-2"]);
      const browserId = useTabStore.getState().addTab("browser", "Browser");
      useTabStore.getState().moveTab(browserId, 0);

      useTabStore.getState().closeTab(browserId);

      // The slot neighbor t-1 takes over via the sentinel, not its raw id.
      expect(selectCurrentActiveTabId(useTabStore.getState())).toBe("terminal");
      expect(useTerminalStore.getState().sessions["/tmp/wt"]?.activeTabId).toBe("t-1");
    });
  });

  describe("moveTab", () => {
    it("reorders a tab to the target index", () => {
      initWorktree();
      useTabStore.getState().syncTerminalTabs("/tmp/wt", ["t-1"]);
      useTabStore.getState().addTab("changes", "Changes");
      vi.spyOn(crypto, "randomUUID").mockReturnValueOnce(
        "b-1" as `${string}-${string}-${string}-${string}-${string}`,
      );
      useTabStore.getState().addTab("browser", "Browser");
      expect(selectCurrentTabs(useTabStore.getState()).map((t) => t.id)).toEqual([
        "t-1",
        "changes",
        "b-1",
      ]);

      useTabStore.getState().moveTab("b-1", 0);
      expect(selectCurrentTabs(useTabStore.getState()).map((t) => t.id)).toEqual([
        "b-1",
        "t-1",
        "changes",
      ]);

      useTabStore.getState().moveTab("b-1", 99);
      expect(selectCurrentTabs(useTabStore.getState()).map((t) => t.id)).toEqual([
        "t-1",
        "changes",
        "b-1",
      ]);
    });
  });

  describe("browser nav cleanup", () => {
    it("closeTab removes the tab's browser nav state", () => {
      initWorktree();
      const id = useTabStore.getState().addTab("browser", "Browser");
      useBrowserStore.getState().navigate(id, "http://localhost:3000/");
      useTabStore.getState().closeTab(id);
      expect(useBrowserStore.getState().navs[id]).toBeUndefined();
    });

    it("removeSession removes nav state for the session's browser tabs", () => {
      useTabStore.getState().setActiveWorktree("/tmp/a");
      const id = useTabStore.getState().addTab("browser", "Browser");
      useBrowserStore.getState().navigate(id, "http://localhost:3000/");
      useTabStore.getState().removeSession("/tmp/a");
      expect(useBrowserStore.getState().navs[id]).toBeUndefined();
    });
  });
});
