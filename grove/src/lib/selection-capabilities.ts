import type { ResolvedSidebarSelection } from "./sidebar-selection";

/**
 * Feature availability for the current sidebar selection.
 *
 * Selections come in two shapes: git-backed directories (project worktrees,
 * source checkouts, mission worktrees) and plain directories (mission roots).
 * Plain directories get directory-scoped features (terminal, file browser,
 * browser) but none of the git-backed ones (changes, commits).
 */
export interface SelectionCapabilities {
  /** Any directory is selected (worktree, source, or mission root). */
  hasDirectory: boolean;
  /** The selected directory is git-backed. */
  hasGit: boolean;
  terminal: boolean;
  browser: boolean;
  fileBrowser: boolean;
  changes: boolean;
  commits: boolean;
}

export function resolveSelectionCapabilities(
  selection: Pick<ResolvedSidebarSelection, "terminalPath" | "worktreePath">,
): SelectionCapabilities {
  const hasDirectory = Boolean(selection.worktreePath ?? selection.terminalPath);
  const hasGit = Boolean(selection.worktreePath);

  return {
    hasDirectory,
    hasGit,
    terminal: hasDirectory,
    browser: hasDirectory,
    fileBrowser: hasDirectory,
    changes: hasGit,
    commits: hasGit,
  };
}
