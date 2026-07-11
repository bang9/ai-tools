import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SplitNode, WorktreeTerminalSession } from "../types";

vi.mock("../lib/platform", () => ({
  loadTerminalLayouts: vi.fn(),
  saveTerminalLayouts: vi.fn(),
}));

import * as platform from "../lib/platform";
import { useTerminalStore } from "./terminal";

function makeLeaf(id: string, ptyId: string): SplitNode {
  return {
    id,
    type: "leaf",
    ptyId,
  };
}

function makeSplit(
  id: string,
  children: SplitNode[],
  type: "horizontal" | "vertical" = "horizontal",
): SplitNode {
  return {
    id,
    type,
    sizes: children.map(() => 1 / children.length),
    children,
  };
}

function makeSession(node: SplitNode, tabId = "tab-1"): WorktreeTerminalSession {
  return { tabs: [{ id: tabId, node }], activeTabId: tabId };
}

describe("useTerminalStore bell state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTerminalStore.setState({
      sessions: {},
      activeWorktree: null,
      focusedPtyId: null,
      focusedPaneIdByTab: {},
      bellPtyIds: new Set<string>(),
      aiSessions: {},
      theme: null,
      detectedTheme: null,
    });
  });

  it("clears bell ptys for the activated worktree", () => {
    useTerminalStore.setState({
      sessions: {
        "/tmp/a": makeSession(makeLeaf("pane-a", "pty-a"), "tab-a"),
        "/tmp/b": makeSession(makeLeaf("pane-b", "pty-b"), "tab-b"),
      },
      bellPtyIds: new Set(["pty-a", "pty-b"]),
    });

    useTerminalStore.getState().setActiveWorktree("/tmp/a");

    expect(useTerminalStore.getState().bellPtyIds).toEqual(new Set(["pty-b"]));
  });

  it("drops bell state for a closed pane only", () => {
    useTerminalStore.setState({
      sessions: {
        "/tmp/a": makeSession(
          {
            id: "split-root",
            type: "horizontal",
            sizes: [1, 1],
            children: [makeLeaf("pane-a", "pty-a"), makeLeaf("pane-b", "pty-b")],
          },
          "tab-a",
        ),
      },
      bellPtyIds: new Set(["pty-a", "pty-b"]),
      focusedPtyId: "pty-a",
    });

    useTerminalStore.getState().closeTerminal("/tmp/a", "pty-a");

    expect(useTerminalStore.getState().bellPtyIds).toEqual(new Set(["pty-b"]));
  });

  it("switches active worktree without a null gap when removing the active session", () => {
    useTerminalStore.setState({
      sessions: {
        "/tmp/source": makeSession(makeLeaf("pane-source", "pty-source"), "tab-source"),
        "/tmp/feature": makeSession(makeLeaf("pane-feature", "pty-feature"), "tab-feature"),
      },
      activeWorktree: "/tmp/feature",
      focusedPtyId: "pty-feature",
      bellPtyIds: new Set(["pty-feature", "pty-source"]),
      aiSessions: {
        "pty-source": { tool: "codex", status: "attention" },
      },
    });

    useTerminalStore.getState().removeSession("/tmp/feature", "/tmp/source");

    expect(useTerminalStore.getState().sessions["/tmp/feature"]).toBeUndefined();
    expect(useTerminalStore.getState().activeWorktree).toBe("/tmp/source");
    expect(useTerminalStore.getState().focusedPtyId).toBe("pty-source");
    expect(useTerminalStore.getState().bellPtyIds).toEqual(new Set());
    expect(useTerminalStore.getState().aiSessions["pty-source"]).toEqual({
      tool: "codex",
      status: "idle",
    });
  });

  it("suppresses attention updates for panes in the active worktree", () => {
    useTerminalStore.setState({
      sessions: {
        "/tmp/source": makeSession(makeLeaf("pane-source", "pty-source"), "tab-source"),
        "/tmp/other": makeSession(makeLeaf("pane-other", "pty-other"), "tab-other"),
      },
      activeWorktree: "/tmp/source",
      aiSessions: {
        "pty-source": { tool: "codex", status: "running" },
      },
    });

    useTerminalStore.getState().updateAiStatus("pty-source", "codex:attention");
    useTerminalStore.getState().updateAiStatus("pty-other", "codex:attention");

    expect(useTerminalStore.getState().aiSessions["pty-source"]).toEqual({
      tool: "codex",
      status: "idle",
    });
    expect(useTerminalStore.getState().aiSessions["pty-other"]).toEqual({
      tool: "codex",
      status: "attention",
    });
  });

  it("clears attention when the pane receives focus", () => {
    useTerminalStore.setState({
      aiSessions: {
        "pty-source": { tool: "codex", status: "attention" },
      },
      focusedPtyId: null,
    });

    useTerminalStore.getState().setFocusedPtyId("pty-source");

    expect(useTerminalStore.getState().focusedPtyId).toBe("pty-source");
    expect(useTerminalStore.getState().aiSessions["pty-source"]).toEqual({
      tool: "codex",
      status: "idle",
    });
  });

  it("restores the previously focused pane when switching back to a worktree", () => {
    useTerminalStore.setState({
      sessions: {
        "/tmp/a": makeSession(
          makeSplit("root-a", [makeLeaf("pane-a-1", "pty-a-1"), makeLeaf("pane-a-2", "pty-a-2")]),
          "tab-a",
        ),
        "/tmp/b": makeSession(makeLeaf("pane-b-1", "pty-b-1"), "tab-b"),
      },
    });

    useTerminalStore.getState().setActiveWorktree("/tmp/a");
    useTerminalStore.getState().setFocusedPtyId("pty-a-2");
    useTerminalStore.getState().setActiveWorktree("/tmp/b");
    useTerminalStore.getState().setActiveWorktree("/tmp/a");

    expect(useTerminalStore.getState().focusedPtyId).toBe("pty-a-2");
    expect(useTerminalStore.getState().focusedPaneIdByTab["tab-a"]).toBe("pane-a-2");
  });

  it("falls back to the first surviving pane when the remembered pane is removed", () => {
    useTerminalStore.setState({
      sessions: {
        "/tmp/a": makeSession(makeLeaf("pane-a-1", "pty-a-1"), "tab-a"),
        "/tmp/b": makeSession(
          makeSplit("root-b", [makeLeaf("pane-b-1", "pty-b-1"), makeLeaf("pane-b-2", "pty-b-2")]),
          "tab-b",
        ),
      },
    });

    useTerminalStore.getState().setActiveWorktree("/tmp/b");
    useTerminalStore.getState().setFocusedPtyId("pty-b-2");
    useTerminalStore.getState().setActiveWorktree("/tmp/a");
    useTerminalStore.getState().closeTerminal("/tmp/b", "pty-b-2");
    useTerminalStore.getState().setActiveWorktree("/tmp/b");

    expect(useTerminalStore.getState().focusedPtyId).toBe("pty-b-1");
    expect(useTerminalStore.getState().focusedPaneIdByTab["tab-b"]).toBe("pane-b-1");
  });

  it("stores pane labels by stable pane id", () => {
    useTerminalStore.setState({
      sessions: {
        "/tmp/a": makeSession(
          makeSplit("root-a", [makeLeaf("pane-a-1", "pty-a-1"), makeLeaf("pane-a-2", "pty-a-2")]),
          "tab-a",
        ),
      },
    });

    useTerminalStore.getState().setPaneLabel("/tmp/a", "pane-a-2", "  review  ");

    const node = useTerminalStore.getState().sessions["/tmp/a"].tabs[0].node;
    expect(node.children![0]).toEqual(makeLeaf("pane-a-1", "pty-a-1"));
    expect(node.children![1]).toEqual({
      ...makeLeaf("pane-a-2", "pty-a-2"),
      label: "review",
    });
  });

  it("clears pane labels back to the unlabeled leaf shape", () => {
    useTerminalStore.setState({
      sessions: {
        "/tmp/a": makeSession(
          {
            ...makeLeaf("pane-a-1", "pty-a-1"),
            label: "review",
          },
          "tab-a",
        ),
      },
    });

    useTerminalStore.getState().setPaneLabel("/tmp/a", "pane-a-1", undefined);

    expect(useTerminalStore.getState().sessions["/tmp/a"].tabs[0].node).toEqual(
      makeLeaf("pane-a-1", "pty-a-1"),
    );
  });

  it("addTab appends a tab, makes it active, and focuses its pane", () => {
    useTerminalStore.setState({
      sessions: {
        "/tmp/a": makeSession(makeLeaf("pane-a-1", "pty-a-1"), "tab-a-1"),
      },
      activeWorktree: "/tmp/a",
    });

    useTerminalStore.getState().addTab("/tmp/a", "pane-a-2", "pty-a-2");

    const session = useTerminalStore.getState().sessions["/tmp/a"];
    expect(session.tabs).toHaveLength(2);
    expect(session.activeTabId).toBe(session.tabs[1].id);
    expect(useTerminalStore.getState().focusedPaneIdByTab[session.tabs[1].id]).toBe("pane-a-2");
    expect(useTerminalStore.getState().focusedPtyId).toBe("pty-a-2");
  });

  it("setActiveTab switches activeTabId and restores that tab's remembered focused pane", () => {
    useTerminalStore.setState({
      sessions: {
        "/tmp/a": {
          tabs: [
            {
              id: "tab-1",
              node: makeSplit("root-1", [
                makeLeaf("pane-1-1", "pty-1-1"),
                makeLeaf("pane-1-2", "pty-1-2"),
              ]),
            },
            { id: "tab-2", node: makeLeaf("pane-2-1", "pty-2-1") },
          ],
          activeTabId: "tab-1",
        },
      },
      activeWorktree: "/tmp/a",
      focusedPaneIdByTab: { "tab-1": "pane-1-2" },
    });

    useTerminalStore.getState().setActiveTab("/tmp/a", "tab-2");

    expect(useTerminalStore.getState().sessions["/tmp/a"].activeTabId).toBe("tab-2");
    expect(useTerminalStore.getState().focusedPtyId).toBe("pty-2-1");

    useTerminalStore.getState().setActiveTab("/tmp/a", "tab-1");

    expect(useTerminalStore.getState().sessions["/tmp/a"].activeTabId).toBe("tab-1");
    expect(useTerminalStore.getState().focusedPtyId).toBe("pty-1-2");
    expect(useTerminalStore.getState().focusedPaneIdByTab["tab-1"]).toBe("pane-1-2");
  });

  it("setActiveTab clears bellPtyIds only for the activated tab's panes", () => {
    useTerminalStore.setState({
      sessions: {
        "/tmp/a": {
          tabs: [
            { id: "tab-1", node: makeLeaf("pane-1", "pty-1") },
            { id: "tab-2", node: makeLeaf("pane-2", "pty-2") },
          ],
          activeTabId: "tab-1",
        },
      },
      activeWorktree: "/tmp/a",
      bellPtyIds: new Set(["pty-1", "pty-2"]),
    });

    useTerminalStore.getState().setActiveTab("/tmp/a", "tab-2");

    expect(useTerminalStore.getState().bellPtyIds).toEqual(new Set(["pty-1"]));
  });

  it("closeTab removes the tab, activates the neighbor, and drops its pty from bellPtyIds/aiSessions", () => {
    useTerminalStore.setState({
      sessions: {
        "/tmp/a": {
          tabs: [
            { id: "tab-1", node: makeLeaf("pane-1", "pty-1") },
            { id: "tab-2", node: makeLeaf("pane-2", "pty-2") },
          ],
          activeTabId: "tab-1",
        },
      },
      activeWorktree: "/tmp/a",
      bellPtyIds: new Set(["pty-1"]),
      aiSessions: { "pty-1": { tool: "claude", status: "idle" } },
    });

    useTerminalStore.getState().closeTab("/tmp/a", "tab-1");

    const session = useTerminalStore.getState().sessions["/tmp/a"];
    expect(session.tabs.map((tab) => tab.id)).toEqual(["tab-2"]);
    expect(session.activeTabId).toBe("tab-2");
    expect(useTerminalStore.getState().bellPtyIds.has("pty-1")).toBe(false);
    expect(useTerminalStore.getState().aiSessions["pty-1"]).toBeUndefined();
  });

  it("closeTab on the last tab removes the whole session and dismisses the worktree", () => {
    useTerminalStore.setState({
      sessions: {
        "/tmp/a": makeSession(makeLeaf("pane-1", "pty-1"), "tab-1"),
      },
      activeWorktree: "/tmp/a",
      dismissedTerminalWorktrees: new Set<string>(),
    });

    useTerminalStore.getState().closeTab("/tmp/a", "tab-1");

    expect(useTerminalStore.getState().sessions["/tmp/a"]).toBeUndefined();
    expect(useTerminalStore.getState().dismissedTerminalWorktrees.has("/tmp/a")).toBe(true);

    // Reopening a terminal clears the dismissal.
    useTerminalStore.getState().createSession("/tmp/a", "pane-9", "pty-9");
    expect(useTerminalStore.getState().dismissedTerminalWorktrees.has("/tmp/a")).toBe(false);
  });

  it("closeTerminal of a tab's last pane removes that tab and activates a remaining tab", () => {
    useTerminalStore.setState({
      sessions: {
        "/tmp/a": {
          tabs: [
            { id: "tab-1", node: makeLeaf("pane-1", "pty-1") },
            { id: "tab-2", node: makeLeaf("pane-2", "pty-2") },
          ],
          activeTabId: "tab-1",
        },
      },
      activeWorktree: "/tmp/a",
      focusedPtyId: "pty-1",
    });

    useTerminalStore.getState().closeTerminal("/tmp/a", "pty-1");

    const session = useTerminalStore.getState().sessions["/tmp/a"];
    expect(session.tabs.map((tab) => tab.id)).toEqual(["tab-2"]);
    expect(session.activeTabId).toBe("tab-2");
    expect(useTerminalStore.getState().focusedPtyId).toBe("pty-2");
  });

  describe("initLayouts", () => {
    it("migrates the legacy bare-SplitNode shape into a single-tab session", async () => {
      vi.mocked(platform.loadTerminalLayouts).mockResolvedValueOnce(
        JSON.stringify({ "/tmp/legacy": { id: "p1", type: "leaf" } }),
      );

      await useTerminalStore.getState().initLayouts();

      const saved = useTerminalStore.getState().getSavedLayout("/tmp/legacy");
      expect(saved).not.toBeNull();
      expect(saved!.tabs).toHaveLength(1);
      expect(saved!.tabs[0].node).toEqual({ id: "p1", type: "leaf", ptyId: undefined });
      expect(saved!.activeTabId).toBe(saved!.tabs[0].id);
    });

    it("round-trips the new tabbed session shape", async () => {
      const persisted = {
        "/tmp/modern": {
          tabs: [{ id: "tab-1", node: { id: "p1", type: "leaf" } }],
          activeTabId: "tab-1",
        },
      };
      vi.mocked(platform.loadTerminalLayouts).mockResolvedValueOnce(JSON.stringify(persisted));

      await useTerminalStore.getState().initLayouts();

      const saved = useTerminalStore.getState().getSavedLayout("/tmp/modern");
      expect(saved).toEqual({
        tabs: [{ id: "tab-1", node: { id: "p1", type: "leaf", ptyId: undefined } }],
        activeTabId: "tab-1",
      });
    });
  });
});
