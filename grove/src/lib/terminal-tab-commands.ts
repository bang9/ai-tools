import { createPty, closePty } from "./platform";
import { runCommandSafely } from "./command";
import { useTerminalStore } from "../store/terminal";
import { useTabStore } from "../store/tab";
import { collectTerminalPanes } from "./terminal-session";

export async function addTerminalTab(worktreePath: string): Promise<void> {
  const hadSession = Boolean(useTerminalStore.getState().sessions[worktreePath]);
  const newPaneId = crypto.randomUUID();
  const newPtyId = crypto.randomUUID();
  const created = await runCommandSafely(
    async () => {
      await createPty({
        ptyId: newPtyId,
        paneId: newPaneId,
        worktreePath,
        cwd: worktreePath,
        cols: 80,
        rows: 24,
      });
      return true;
    },
    {
      errorToast: "Failed to open terminal tab",
    },
  );
  if (!created) return;

  // Without a session (fresh worktree or a dismissed terminal) this doubles
  // as "reopen the terminal": create the session, which also clears dismissal.
  if (hadSession) {
    useTerminalStore.getState().addTab(worktreePath, newPaneId, newPtyId);
  } else {
    useTerminalStore.getState().createSession(worktreePath, newPaneId, newPtyId);
  }
}

export async function closeTerminalTab(worktreePath: string, tabId: string): Promise<void> {
  const session = useTerminalStore.getState().sessions[worktreePath];
  const tab = session?.tabs.find((entry) => entry.id === tabId);
  if (!tab) return;

  const ptyIds = collectTerminalPanes(tab.node)
    .map((pane) => pane.ptyId)
    .filter((ptyId): ptyId is string => Boolean(ptyId));

  // When the visible tab closes, its nearest neighbor in the UNIFIED tab list
  // takes over — terminal entries sit alongside browser/changes tabs there, so
  // the terminal store's own (creation) order must not pick the successor.
  const tabSession = useTabStore.getState().sessions[worktreePath];
  const closedIndex = tabSession?.tabs.findIndex((entry) => entry.id === tabId) ?? -1;
  const wasVisible = tabSession?.activeTabId === "terminal" && session.activeTabId === tabId;

  useTerminalStore.getState().closeTab(worktreePath, tabId);

  if (wasVisible && closedIndex >= 0) {
    const tabState = useTabStore.getState();
    const remaining = tabState.sessions[worktreePath]?.tabs ?? [];
    const neighbor = remaining[Math.min(closedIndex, remaining.length - 1)];
    if (neighbor?.type === "terminal") {
      useTerminalStore.getState().setActiveTab(worktreePath, neighbor.id);
    } else if (neighbor && tabState.activeWorktree === worktreePath) {
      tabState.setActiveTab(neighbor.id);
    }
  }
  await Promise.all(
    ptyIds.map((ptyId) =>
      runCommandSafely(() => closePty(ptyId), {
        errorToast: "Failed to close terminal tab",
      }),
    ),
  );
}
