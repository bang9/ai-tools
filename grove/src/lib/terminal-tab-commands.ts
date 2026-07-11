import { createPty, closePty } from "./platform";
import { runCommandSafely } from "./command";
import { useTerminalStore } from "../store/terminal";
import { collectTerminalPanes } from "./terminal-session";

export async function addTerminalTab(worktreePath: string): Promise<void> {
  // Tabs attach to an existing session; without one the pty would leak
  // because the store's addTab is a no-op.
  if (!useTerminalStore.getState().sessions[worktreePath]) return;
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
  if (created) {
    useTerminalStore.getState().addTab(worktreePath, newPaneId, newPtyId);
  }
}

export async function closeTerminalTab(worktreePath: string, tabId: string): Promise<void> {
  const session = useTerminalStore.getState().sessions[worktreePath];
  const tab = session?.tabs.find((entry) => entry.id === tabId);
  if (!tab) return;

  const ptyIds = collectTerminalPanes(tab.node)
    .map((pane) => pane.ptyId)
    .filter((ptyId): ptyId is string => Boolean(ptyId));

  useTerminalStore.getState().closeTab(worktreePath, tabId);
  await Promise.all(
    ptyIds.map((ptyId) =>
      runCommandSafely(() => closePty(ptyId), {
        errorToast: "Failed to close terminal tab",
      }),
    ),
  );
}
