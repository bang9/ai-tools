import { describe, expect, it } from "vitest";
import type { SplitNode } from "../../types";
import { restoreLayoutWithPtyIds } from "../../lib/terminal-session";
import { buildPtyIdToWorktreeIndex } from "./TerminalPanel";

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

describe("buildPtyIdToWorktreeIndex", () => {
  it("maps every pty id to its owning worktree path", () => {
    const sessions = {
      "/tmp/project-a": restoreLayoutWithPtyIds(
        layout,
        new Map([["pane-a", "pty-a"]]),
      ),
      "/tmp/project-b": restoreLayoutWithPtyIds(
        layout,
        new Map([
          ["pane-b", "pty-b"],
          ["pane-c", "pty-c"],
        ]),
      ),
    };

    const index = buildPtyIdToWorktreeIndex(sessions);

    expect(index.get("pty-a")).toBe("/tmp/project-a");
    expect(index.get("pty-b")).toBe("/tmp/project-b");
    expect(index.get("pty-c")).toBe("/tmp/project-b");
    expect(index.get("missing")).toBeUndefined();
  });

  it("skips leaf panes without a live pty id", () => {
    const sessions = { "/tmp/project-a": layout };

    const index = buildPtyIdToWorktreeIndex(sessions);

    expect(index.size).toBe(0);
  });

  it("re-resolves a ptyId rebound to a different worktree after a rebuild", () => {
    const movedLayout = restoreLayoutWithPtyIds(
      layout,
      new Map([["pane-a", "pty-a"]]),
    );

    const before = buildPtyIdToWorktreeIndex({
      "/tmp/project-a": movedLayout,
    });
    expect(before.get("pty-a")).toBe("/tmp/project-a");

    // Simulate the pty moving to a different worktree's tree (split-tree move).
    const after = buildPtyIdToWorktreeIndex({
      "/tmp/project-b": movedLayout,
    });
    expect(after.get("pty-a")).toBe("/tmp/project-b");
  });

  it("returns an empty map for no sessions", () => {
    expect(buildPtyIdToWorktreeIndex({}).size).toBe(0);
  });
});
