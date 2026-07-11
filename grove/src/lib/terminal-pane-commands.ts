import { createPty, closePty } from "./platform";
import { runCommandSafely } from "./command";
import { useTerminalStore } from "../store/terminal";
import { useBroadcastStore } from "../store/broadcast";
import { useProjectStore } from "../store/project";
import { usePanelLayoutStore } from "../store/panel-layout";
import { getRuntimeSize, captureRuntimeSnapshot } from "./terminal-runtime";
import { getGlobalTerminalMirrorTitle } from "./global-terminal-title";

export async function splitTerminalPane(
  worktreePath: string,
  ptyId: string,
  direction: "horizontal" | "vertical",
): Promise<void> {
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
      errorToast: "Failed to split terminal",
    },
  );
  if (created) {
    useTerminalStore.getState().splitTerminal(worktreePath, ptyId, direction, newPaneId, newPtyId);
  }
}

export async function closeTerminalPane(worktreePath: string, ptyId: string): Promise<void> {
  useTerminalStore.getState().closeTerminal(worktreePath, ptyId);
  await runCommandSafely(() => closePty(ptyId), {
    errorToast: "Failed to close terminal",
  });
}

export function mirrorTerminalPane(paneId: string, ptyId: string): void {
  const { isMirroring, startMirror } = useBroadcastStore.getState();
  if (isMirroring(ptyId)) return;

  const { projects, selectedWorktree } = useProjectStore.getState();
  const title = getGlobalTerminalMirrorTitle(projects, selectedWorktree);

  const { cols, rows } = getRuntimeSize(paneId);
  const snapshot = captureRuntimeSnapshot(paneId);
  startMirror(ptyId, paneId, cols, rows, snapshot);
  usePanelLayoutStore.getState().addGlobalTerminalMirrorTab(title, ptyId);
}
