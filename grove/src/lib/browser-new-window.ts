/**
 * Where a `target="_blank"` / `window.open()` popup tab belongs.
 *
 * Browser tabs of EVERY worktree stay mounted and keep running in the
 * background, so a page that opens a new window may well live in a worktree the
 * user is not looking at. Routing the tab into the visible session (the old
 * behavior) would drop it in the wrong worktree.
 *
 * Policy:
 * • The worktree whose session contains the opener tab owns the new tab.
 * • Unknown/empty opener, or no session contains it → the active session,
 *   focused (today's behavior).
 * • The tab is activated ONLY when its owner worktree is the active one. A
 *   background worktree must not have its active tab yanked — the user would
 *   come back to a popup instead of the page they left. The tab still shows up
 *   in that worktree's tab bar.
 */

export interface NewWindowTarget {
  /** null → fall back to the active session. */
  worktreePath: string | null;
  activate: boolean;
}

export function resolveNewWindowTarget(
  sessions: Record<string, { tabs: { id: string }[] }>,
  activeWorktree: string | null,
  openerTabId: string,
): NewWindowTarget {
  if (!openerTabId) return { worktreePath: null, activate: true };
  for (const [worktreePath, session] of Object.entries(sessions)) {
    if (session.tabs.some((tab) => tab.id === openerTabId)) {
      return { worktreePath, activate: worktreePath === activeWorktree };
    }
  }
  return { worktreePath: null, activate: true };
}
