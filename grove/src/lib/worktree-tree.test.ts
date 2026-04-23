import { describe, expect, it } from "vitest";
import type { Worktree } from "../types";
import { buildWorktreeTree } from "./worktree-tree";

function makeWorktree(
  name: string,
  stackParentName?: string | null,
): Worktree {
  return {
    name,
    path: `/tmp/${name}`,
    branch: name,
    stackParentName,
  };
}

describe("buildWorktreeTree", () => {
  it("builds a recursive tree for stacked worktrees", () => {
    const tree = buildWorktreeTree([
      makeWorktree("feature/auth"),
      makeWorktree("fix/token", "feature/auth"),
      makeWorktree("spike/oauth", "fix/token"),
      makeWorktree("chore/docs"),
    ]);

    expect(tree).toHaveLength(2);
    expect(tree[0]?.worktree.name).toBe("feature/auth");
    expect(tree[0]?.descendantCount).toBe(2);
    expect(tree[0]?.children[0]?.worktree.name).toBe("fix/token");
    expect(tree[0]?.children[0]?.depth).toBe(1);
    expect(tree[0]?.children[0]?.children[0]?.worktree.name).toBe("spike/oauth");
    expect(tree[0]?.children[0]?.children[0]?.depth).toBe(2);
    expect(tree[1]?.worktree.name).toBe("chore/docs");
  });

  it("promotes orphaned stacked worktrees to roots", () => {
    const tree = buildWorktreeTree([
      makeWorktree("feature/auth"),
      makeWorktree("fix/token", "missing-parent"),
    ]);

    expect(tree.map((node) => node.worktree.name)).toEqual([
      "feature/auth",
      "fix/token",
    ]);
    expect(tree[1]?.depth).toBe(0);
  });

  it("keeps cyclic input visible instead of recursing forever", () => {
    const tree = buildWorktreeTree([
      makeWorktree("feature/auth", "fix/token"),
      makeWorktree("fix/token", "feature/auth"),
    ]);

    expect(tree.map((node) => node.worktree.name)).toEqual([
      "feature/auth",
      "fix/token",
    ]);
    expect(tree.every((node) => node.depth === 0)).toBe(true);
  });
});
