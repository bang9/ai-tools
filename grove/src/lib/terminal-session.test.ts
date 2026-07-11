import { describe, expect, it } from "vitest";
import type { SplitNode, WorktreeTerminalSession } from "../types";
import { normalizeSplitTree, toLayoutTemplate } from "./split-tree";
import {
  buildTerminalPaneTopologySignature,
  buildTerminalRestorePlan,
  buildTerminalSnapshotRequest,
  collectTerminalPanes,
  findWorktreePathForPtyId,
  restoreLayoutWithPtyIds,
} from "./terminal-session";

function makeSession(node: SplitNode, tabId = "tab-1"): WorktreeTerminalSession {
  return { tabs: [{ id: tabId, node }], activeTabId: tabId };
}

const layout: SplitNode = {
  id: "root",
  type: "horizontal",
  sizes: [0.4, 0.6],
  children: [
    { id: "pane-a", type: "leaf" },
    {
      id: "branch-b",
      type: "vertical",
      sizes: [0.5, 0.5],
      children: [
        { id: "pane-b", type: "leaf" },
        { id: "pane-c", type: "leaf" },
      ],
    },
  ],
};

describe("collectTerminalPanes", () => {
  it("returns leaf panes in layout order", () => {
    expect(collectTerminalPanes(layout)).toEqual([
      { paneId: "pane-a", ptyId: undefined },
      { paneId: "pane-b", ptyId: undefined },
      { paneId: "pane-c", ptyId: undefined },
    ]);
  });

  it("reuses cached pane entries for the same immutable layout node", () => {
    const first = collectTerminalPanes(layout);
    const second = collectTerminalPanes(layout);

    expect(second).toBe(first);
  });
});

describe("buildTerminalPaneTopologySignature", () => {
  it("tracks stable pane identity without pty ids", () => {
    expect(buildTerminalPaneTopologySignature(makeSession(layout))).toBe("pane-a|pane-b|pane-c");
    expect(
      buildTerminalPaneTopologySignature(
        makeSession(
          restoreLayoutWithPtyIds(
            layout,
            new Map([
              ["pane-a", "pty-1"],
              ["pane-b", "pty-2"],
            ]),
          ),
        ),
      ),
    ).toBe("pane-a|pane-b|pane-c");
  });

  it("joins multiple tabs' pane ids with a double pipe", () => {
    const session: WorktreeTerminalSession = {
      tabs: [
        { id: "tab-1", node: { id: "pane-a", type: "leaf" } },
        { id: "tab-2", node: { id: "pane-b", type: "leaf" } },
      ],
      activeTabId: "tab-1",
    };

    expect(buildTerminalPaneTopologySignature(session)).toBe("pane-a||pane-b");
  });
});

describe("restoreLayoutWithPtyIds", () => {
  it("maps runtime PTY ids onto stable pane ids", () => {
    const restored = restoreLayoutWithPtyIds(
      layout,
      new Map([
        ["pane-a", "pty-1"],
        ["pane-b", "pty-2"],
        ["pane-c", "pty-3"],
      ]),
    );

    expect(restored.children?.[0]).toEqual({
      id: "pane-a",
      type: "leaf",
      ptyId: "pty-1",
    });
    expect(restored.children?.[1].children?.[0]).toEqual({
      id: "pane-b",
      type: "leaf",
      ptyId: "pty-2",
    });
    expect(restored.children?.[1].children?.[1]).toEqual({
      id: "pane-c",
      type: "leaf",
      ptyId: "pty-3",
    });
  });

  it("preserves persisted pane labels while restoring runtime PTY ids", () => {
    const restored = restoreLayoutWithPtyIds(
      {
        id: "pane-a",
        type: "leaf",
        label: "build api",
      },
      new Map([["pane-a", "pty-1"]]),
    );

    expect(restored).toEqual({
      id: "pane-a",
      type: "leaf",
      ptyId: "pty-1",
      label: "build api",
    });
  });

  it("preserves pane labels across the persisted-layout restart path", () => {
    const liveLayout: SplitNode = {
      id: "root",
      type: "horizontal",
      sizes: [0.5, 0.5],
      children: [
        { id: "pane-a", type: "leaf", ptyId: "pty-old-a", label: "build api" },
        { id: "pane-b", type: "leaf", ptyId: "pty-old-b" },
      ],
    };
    const persistedTemplate = toLayoutTemplate(liveLayout);
    const loadedTemplate = normalizeSplitTree(persistedTemplate, () => "unused");
    const restoredLiveLayout = restoreLayoutWithPtyIds(
      loadedTemplate,
      new Map([
        ["pane-a", "pty-new-a"],
        ["pane-b", "pty-new-b"],
      ]),
    );
    const restoredStoreLayout = normalizeSplitTree(restoredLiveLayout, () => "unused");

    expect(persistedTemplate.children?.[0]).toEqual({
      id: "pane-a",
      type: "leaf",
      label: "build api",
    });
    expect(restoredStoreLayout.children?.[0]).toEqual({
      id: "pane-a",
      type: "leaf",
      ptyId: "pty-new-a",
      label: "build api",
    });
  });
});

describe("buildTerminalRestorePlan", () => {
  it("uses per-pane snapshot cwd and scrollback when available", () => {
    const plan = buildTerminalRestorePlan(
      layout,
      {
        worktreePath: "/tmp/project",
        panes: [
          {
            paneId: "pane-c",
            scrollback: "git status\r\n",
            scrollbackTruncated: false,
            launchCwd: "/tmp/project",
            lastKnownCwd: "/tmp/project/src",
            restoreCwd: "/tmp/project/src",
            restoreCwdSource: "lastKnownCwd",
          },
          {
            paneId: "pane-a",
            scrollback: "pnpm test\r\n",
            scrollbackTruncated: true,
            launchCwd: "/tmp/project",
            lastKnownCwd: null,
            restoreCwd: "/tmp/project",
            restoreCwdSource: "launchCwd",
          },
        ],
      },
      "/tmp/project",
    );

    expect(plan).toEqual([
      {
        paneId: "pane-a",
        launchCwd: "/tmp/project",
        lastKnownCwd: null,
        restoreCwd: "/tmp/project",
        restoreCwdSource: "launchCwd",
        scrollback: "pnpm test\r\n",
        scrollbackTruncated: true,
      },
      {
        paneId: "pane-b",
        launchCwd: "/tmp/project",
        lastKnownCwd: null,
        restoreCwd: "/tmp/project",
        restoreCwdSource: "fallback",
        scrollback: "",
        scrollbackTruncated: false,
      },
      {
        paneId: "pane-c",
        launchCwd: "/tmp/project",
        lastKnownCwd: "/tmp/project/src",
        restoreCwd: "/tmp/project/src",
        restoreCwdSource: "lastKnownCwd",
        scrollback: "git status\r\n",
        scrollbackTruncated: false,
      },
    ]);
  });
});

describe("buildTerminalSnapshotRequest", () => {
  it("includes pane ids, runtime PTY ids, and known launch cwd metadata", () => {
    const liveLayout = restoreLayoutWithPtyIds(
      layout,
      new Map([
        ["pane-a", "pty-1"],
        ["pane-b", "pty-2"],
      ]),
    );

    expect(
      buildTerminalSnapshotRequest(
        "/tmp/project",
        makeSession(liveLayout),
        new Map([
          ["pane-a", "/tmp/project"],
          ["pane-b", "/tmp/project/src"],
        ]),
      ),
    ).toEqual({
      worktreePath: "/tmp/project",
      panes: [
        { paneId: "pane-a", ptyId: "pty-1", launchCwd: "/tmp/project" },
        { paneId: "pane-b", ptyId: "pty-2", launchCwd: "/tmp/project/src" },
        { paneId: "pane-c", ptyId: undefined, launchCwd: undefined },
      ],
    });
  });

  it("can clear a saved snapshot for a removed worktree", () => {
    expect(buildTerminalSnapshotRequest("/tmp/project", undefined)).toEqual({
      worktreePath: "/tmp/project",
      panes: [],
    });
  });
});

describe("findWorktreePathForPtyId", () => {
  it("returns the owning worktree for a live PTY id", () => {
    const sessions = {
      "/tmp/project-a": makeSession(
        restoreLayoutWithPtyIds(layout, new Map([["pane-a", "pty-a"]])),
      ),
      "/tmp/project-b": makeSession(
        restoreLayoutWithPtyIds(layout, new Map([["pane-b", "pty-b"]])),
      ),
    };

    expect(findWorktreePathForPtyId(sessions, "pty-b")).toBe("/tmp/project-b");
    expect(findWorktreePathForPtyId(sessions, "missing")).toBeNull();
  });
});
