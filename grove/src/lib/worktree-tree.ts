import type { Worktree } from "../types";

export interface WorktreeTreeNode {
  worktree: Worktree;
  depth: number;
  descendantCount: number;
  children: WorktreeTreeNode[];
}

function hasParentCycle(start: string, parentByChild: Map<string, string>): boolean {
  const seen = new Set<string>();
  let current = start;

  while (true) {
    const parent = parentByChild.get(current);
    if (!parent) {
      return false;
    }
    if (seen.has(current)) {
      return true;
    }
    seen.add(current);
    current = parent;
  }
}

export function buildWorktreeTree(worktrees: Worktree[]): WorktreeTreeNode[] {
  const worktreeByName = new Map(worktrees.map((worktree) => [worktree.name, worktree]));
  const parentByChild = new Map(
    worktrees
      .filter((worktree) => {
        const parentName = worktree.stackParentName ?? null;
        return parentName != null && parentName !== worktree.name && worktreeByName.has(parentName);
      })
      .map((worktree) => [worktree.name, worktree.stackParentName as string]),
  );
  const invalidChildren = new Set(
    Array.from(parentByChild.keys()).filter((child) => hasParentCycle(child, parentByChild)),
  );
  const childrenByParent = new Map<string, Worktree[]>();
  const roots: Worktree[] = [];

  for (const worktree of worktrees) {
    const parentName = parentByChild.get(worktree.name) ?? null;
    if (parentName && !invalidChildren.has(worktree.name)) {
      const siblings = childrenByParent.get(parentName) ?? [];
      siblings.push(worktree);
      childrenByParent.set(parentName, siblings);
      continue;
    }

    roots.push(worktree);
  }

  const visited = new Set<string>();

  const buildNode = (
    worktree: Worktree,
    depth: number,
    ancestors: Set<string>,
  ): WorktreeTreeNode => {
    visited.add(worktree.name);

    const nextAncestors = new Set(ancestors);
    nextAncestors.add(worktree.name);

    const children = (childrenByParent.get(worktree.name) ?? [])
      .filter((child) => !nextAncestors.has(child.name))
      .map((child) => buildNode(child, depth + 1, nextAncestors));

    const descendantCount = children.reduce((count, child) => count + 1 + child.descendantCount, 0);

    return {
      worktree,
      depth,
      descendantCount,
      children,
    };
  };

  const tree = roots.map((root) => buildNode(root, 0, new Set<string>()));

  for (const worktree of worktrees) {
    if (!visited.has(worktree.name)) {
      tree.push(buildNode(worktree, 0, new Set<string>()));
    }
  }

  return tree;
}
