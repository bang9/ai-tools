import { useCallback } from "react";
import { useTerminalStore } from "../store/terminal";
import {
  createPty as ipcCreatePty,
  loadTerminalSessionSnapshot,
  type CreatePtyRequest,
  type CreatePtyRestore,
} from "../lib/platform";
import { runCommand, runCommandSafely } from "../lib/command";
import {
  buildTerminalRestorePlan,
  findFirstTerminalPane,
  restoreLayoutWithPtyIds,
} from "../lib/terminal-session";
import { primeTerminalPane } from "../lib/terminal-runtime";
import { buildTerminalPaneSeed } from "../lib/terminal-startup";

export function useTerminal() {
  const createSession = useTerminalStore((s) => s.createSession);
  const restoreSession = useTerminalStore((s) => s.restoreSession);
  const getSavedLayout = useTerminalStore((s) => s.getSavedLayout);

  const createTerminal = useCallback(
    async (worktreePath: string) => {
      const createPty = (
        request: Omit<CreatePtyRequest, "cols" | "rows" | "restore">,
        restore?: CreatePtyRestore,
      ) =>
        runCommand(
          () =>
            ipcCreatePty({
              ...request,
              cols: 80,
              rows: 24,
              restore,
            }),
          {
            errorToast: false,
          },
        );

      // Check for saved layout
      const savedLayout = getSavedLayout(worktreePath);
      if (savedLayout) {
        // Snapshot data seeds cwd/scrollback only when a Grove-managed tmux session
        // is missing. Existing tmux sessions remain the primary restore path.
        const snapshot = await runCommandSafely(() => loadTerminalSessionSnapshot(worktreePath), {
          errorToast: false,
        });
        const session = structuredClone(savedLayout);
        const panePtyIds = new Map<string, string>();

        for (const tab of session.tabs) {
          const restorePlan = buildTerminalRestorePlan(tab.node, snapshot, worktreePath);
          for (const pane of restorePlan) {
            const ptyId = crypto.randomUUID();
            const createResult = await createPty(
              {
                ptyId,
                paneId: pane.paneId,
                worktreePath,
                cwd: pane.restoreCwd,
              },
              {
                lastKnownCwd:
                  pane.restoreCwdSource === "lastKnownCwd" ? pane.lastKnownCwd : undefined,
                scrollback: pane.scrollback,
                scrollbackTruncated: pane.scrollbackTruncated,
              },
            );
            panePtyIds.set(pane.paneId, ptyId);
            primeTerminalPane(pane.paneId, buildTerminalPaneSeed(pane, ptyId, createResult));
          }
        }

        const restoredTabs = session.tabs.map((tab) => ({
          id: tab.id,
          node: restoreLayoutWithPtyIds(tab.node, panePtyIds),
        }));
        restoreSession(worktreePath, { tabs: restoredTabs, activeTabId: session.activeTabId });
        const activeTab =
          restoredTabs.find((tab) => tab.id === session.activeTabId) ?? restoredTabs[0];
        const firstActivePane = activeTab ? findFirstTerminalPane(activeTab.node) : null;
        return firstActivePane?.ptyId ?? null;
      }

      // No saved layout — single terminal
      const paneId = crypto.randomUUID();
      const ptyId = crypto.randomUUID();
      await createPty({ ptyId, paneId, worktreePath, cwd: worktreePath });
      createSession(worktreePath, paneId, ptyId);
      return ptyId;
    },
    [createSession, getSavedLayout, restoreSession],
  );

  return {
    createTerminal,
  };
}
