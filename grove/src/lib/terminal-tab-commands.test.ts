import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./platform", () => ({
  createPty: vi.fn(),
  closePty: vi.fn(),
  loadTerminalLayouts: vi.fn(),
  saveTerminalLayouts: vi.fn(),
}));

vi.mock("./command", () => ({
  runCommand: vi.fn(async (fn: () => unknown) => fn()),
  runCommandSafely: vi.fn(async (fn: () => unknown) => {
    try {
      return await fn();
    } catch {
      return null;
    }
  }),
}));

import type { AppTab, SplitNode } from "../types";
import * as platform from "./platform";
import { useTerminalStore } from "../store/terminal";
import { useTabStore } from "../store/tab";
import { initTerminalTabSync } from "./terminal-tab-sync";
import { addTerminalTab, closeTerminalTab } from "./terminal-tab-commands";

const WORKTREE = "/tmp/worktree";

function leaf(id: string, ptyId: string): SplitNode {
  return { id, type: "leaf", ptyId };
}

function entry(id: string): AppTab {
  return id.startsWith("t-")
    ? { id, type: "terminal", title: "Terminal", closable: true }
    : { id, type: "browser", title: "Browser", closable: true };
}

/** Terminal store tabs in creation order; unified list order set separately. */
function setup(terminalTabIds: string[], unifiedOrder: string[], activeTabId: string) {
  useTerminalStore.setState({
    sessions: {
      [WORKTREE]: {
        tabs: terminalTabIds.map((id, i) => ({ id, node: leaf(`p-${i}`, `pty-${i}`) })),
        activeTabId: terminalTabIds[0],
      },
    },
  });
  useTabStore.setState({
    activeWorktree: WORKTREE,
    sessions: {
      [WORKTREE]: { tabs: unifiedOrder.map(entry), activeTabId },
    },
  });
}

const unsubscribeSync = initTerminalTabSync();

describe("terminal tab commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTerminalStore.setState({
      sessions: {},
      activeWorktree: WORKTREE,
      focusedPtyId: null,
      focusedPaneIdByTab: {},
      bellPtyIds: new Set<string>(),
      aiSessions: {},
      dismissedTerminalWorktrees: new Set<string>(),
    });
    useTabStore.setState({ sessions: {}, activeWorktree: null });
  });

  afterAll(() => {
    unsubscribeSync();
  });

  describe("closeTerminalTab", () => {
    it("closes the tab's ptys and removes its unified entry", async () => {
      setup(["t-1", "t-2"], ["t-1", "t-2"], "terminal");

      await closeTerminalTab(WORKTREE, "t-2");

      expect(platform.closePty).toHaveBeenCalledWith("pty-1");
      expect(useTabStore.getState().sessions[WORKTREE].tabs.map((t) => t.id)).toEqual(["t-1"]);
    });

    it("visible tab close picks the nearest UNIFIED neighbor, not terminal-store order", async () => {
      // Terminal store order t-1,t-2,t-3 would pick t-3 after closing t-2;
      // the unified list places t-1 in the vacated slot instead.
      setup(["t-1", "t-2", "t-3"], ["t-2", "t-1", "t-3", "b-1"], "terminal");
      useTerminalStore.getState().setActiveTab(WORKTREE, "t-2");

      await closeTerminalTab(WORKTREE, "t-2");

      expect(useTerminalStore.getState().sessions[WORKTREE].activeTabId).toBe("t-1");
      expect(useTabStore.getState().sessions[WORKTREE].activeTabId).toBe("terminal");
    });

    it("visible tab close activates a non-terminal neighbor via the tab store", async () => {
      setup(["t-1", "t-2"], ["t-2", "t-1", "b-1"], "terminal");
      useTerminalStore.getState().setActiveTab(WORKTREE, "t-1");

      await closeTerminalTab(WORKTREE, "t-1");

      expect(useTabStore.getState().sessions[WORKTREE].activeTabId).toBe("b-1");
    });

    it("background tab close leaves the current selection alone", async () => {
      setup(["t-1", "t-2"], ["t-1", "t-2", "b-1"], "b-1");

      await closeTerminalTab(WORKTREE, "t-1");

      expect(useTabStore.getState().sessions[WORKTREE].activeTabId).toBe("b-1");
    });

    it("closing the last terminal tab dismisses the session and selects the neighbor", async () => {
      setup(["t-1"], ["t-1", "b-1"], "terminal");

      await closeTerminalTab(WORKTREE, "t-1");

      const state = useTerminalStore.getState();
      expect(state.sessions[WORKTREE]).toBeUndefined();
      expect(state.dismissedTerminalWorktrees.has(WORKTREE)).toBe(true);
      expect(useTabStore.getState().sessions[WORKTREE].activeTabId).toBe("b-1");
    });
  });

  describe("addTerminalTab", () => {
    it("appends the new tab at the end of the unified list", async () => {
      setup(["t-1"], ["t-1", "b-1"], "b-1");

      await addTerminalTab(WORKTREE);

      const session = useTerminalStore.getState().sessions[WORKTREE];
      expect(session.tabs).toHaveLength(2);
      const newId = session.tabs[1].id;
      expect(session.activeTabId).toBe(newId);
      expect(useTabStore.getState().sessions[WORKTREE].tabs.map((t) => t.id)).toEqual([
        "t-1",
        "b-1",
        newId,
      ]);
    });
  });
});
