import { useCallback, useMemo, useState } from "react";
import { writePty } from "../lib/platform";
import { runCommandSafely } from "../lib/command";
import {
  executeTerminalCommand,
  isTerminalCommandEnabled,
  type TerminalCommandDefinition,
} from "../lib/terminal-command-pipeline";
import { useTerminalStore } from "../store/terminal";
import { useProjectStore } from "../store/project";
import { usePanelLayoutStore } from "../store/panel-layout";
import { useBroadcastStore } from "../store/broadcast";
import { getRuntimeSize, captureRuntimeSnapshot } from "../lib/terminal-runtime";
import { collectTerminalPanes } from "../lib/terminal-session";
import { TERMINAL_TOOLBAR_COMMANDS } from "../lib/terminal-command-registry";
import { getGlobalTerminalMirrorTitle } from "../lib/global-terminal-title";
import { useTerminal } from "./useTerminal";
import { countLeaves } from "../lib/split-tree";

export function useTerminalCommandPipeline() {
  const activeWorktree = useTerminalStore((s) => s.activeWorktree);
  const focusedPtyId = useTerminalStore((s) => s.focusedPtyId);
  const activeSession = useTerminalStore((s) =>
    s.activeWorktree ? (s.sessions[s.activeWorktree] ?? null) : null,
  );
  const { splitCurrent, closeCurrent, refreshCurrent } = useTerminal();

  const terminalCount = useMemo(() => {
    return activeSession ? countLeaves(activeSession) : 0;
  }, [activeSession]);

  const sendText = useCallback(
    async (text: string, options?: { addNewline?: boolean }) => {
      if (!focusedPtyId) {
        return;
      }

      const payload = options?.addNewline === false ? text : `${text}\r`;
      const bytes = new TextEncoder().encode(payload);

      await runCommandSafely(() => writePty(focusedPtyId, bytes), {
        errorToast: "Failed to send terminal command",
      });
    },
    [focusedPtyId],
  );

  const mirrorTerminal = useCallback(() => {
    const ptyId = useTerminalStore.getState().focusedPtyId;
    if (!ptyId) return;

    const { isMirroring, startMirror } = useBroadcastStore.getState();
    if (isMirroring(ptyId)) return;

    // Find paneId for the focused pty
    const sessions = useTerminalStore.getState().sessions;
    let paneId = "";
    for (const node of Object.values(sessions)) {
      for (const pane of collectTerminalPanes(node)) {
        if (pane.ptyId === ptyId) {
          paneId = pane.paneId;
          break;
        }
      }
      if (paneId) break;
    }
    if (!paneId) return;

    const worktree = useProjectStore.getState().selectedWorktree;
    const projects = useProjectStore.getState().projects;
    const title = getGlobalTerminalMirrorTitle(projects, worktree);

    const { cols, rows } = getRuntimeSize(paneId);
    const snapshot = captureRuntimeSnapshot(paneId);
    startMirror(ptyId, paneId, cols, rows, snapshot);
    usePanelLayoutStore.getState().addGlobalTerminalMirrorTab(title, ptyId);
  }, []);

  const context = useMemo(
    () => ({
      activeWorktree,
      focusedPtyId,
      terminalCount,
      splitTerminal: splitCurrent,
      closeTerminal: closeCurrent,
      refreshTerminal: refreshCurrent,
      mirrorTerminal,
      sendText,
    }),
    [
      activeWorktree,
      closeCurrent,
      focusedPtyId,
      mirrorTerminal,
      refreshCurrent,
      terminalCount,
      sendText,
      splitCurrent,
    ],
  );

  const [executingIds, setExecutingIds] = useState<ReadonlySet<string>>(() => new Set());

  const executeCommand = useCallback(
    async (command: TerminalCommandDefinition) => {
      if (command.disableWhileExecuting) {
        let alreadyExecuting = false;
        setExecutingIds((prev) => {
          if (prev.has(command.id)) {
            alreadyExecuting = true;
            return prev;
          }
          return new Set(prev).add(command.id);
        });
        if (alreadyExecuting) return;
        try {
          await executeTerminalCommand(command, context);
        } finally {
          setExecutingIds((prev) => {
            const next = new Set(prev);
            next.delete(command.id);
            return next;
          });
        }
        return;
      }
      await executeTerminalCommand(command, context);
    },
    [context],
  );

  const isCommandEnabled = useCallback(
    (command: TerminalCommandDefinition) => {
      if (executingIds.has(command.id)) return false;
      return isTerminalCommandEnabled(command, context);
    },
    [context, executingIds],
  );

  return {
    commands: TERMINAL_TOOLBAR_COMMANDS,
    executeCommand,
    isCommandEnabled,
  };
}
