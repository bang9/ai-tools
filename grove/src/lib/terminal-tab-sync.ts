import { useTerminalStore } from "../store/terminal";
import { useTabStore } from "../store/tab";
import type { WorktreeTerminalSession } from "../types";

function terminalTabIds(session: WorktreeTerminalSession | undefined): string[] | null {
  return session ? session.tabs.map((tab) => tab.id) : null;
}

/**
 * Mirror terminal-store tab ids into the tab store's ordered tab list.
 *
 * Only worktrees whose terminal session object actually changed are touched:
 * terminal sessions load lazily per worktree, so a scope with no session yet
 * must keep its persisted terminal entries until the session restores and
 * confirms (or replaces) them.
 */
export function initTerminalTabSync(): () => void {
  return useTerminalStore.subscribe((state, previousState) => {
    if (state.sessions === previousState.sessions) {
      return;
    }

    const worktreePaths = new Set([
      ...Object.keys(previousState.sessions),
      ...Object.keys(state.sessions),
    ]);
    for (const worktreePath of worktreePaths) {
      const session = state.sessions[worktreePath];
      if (session === previousState.sessions[worktreePath]) {
        continue;
      }
      useTabStore.getState().syncTerminalTabs(worktreePath, terminalTabIds(session));
    }
  });
}
