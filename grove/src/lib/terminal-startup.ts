import type { TerminalPaneSeed } from "./terminal-runtime";
import type { TerminalRestorePlanEntry } from "./terminal-session";
import type { CreatePtyResult } from "./platform";

export function buildTerminalPaneSeed(
  pane: Pick<TerminalRestorePlanEntry, "launchCwd" | "scrollback">,
  ptyId: string,
  createResult: CreatePtyResult,
): TerminalPaneSeed {
  if (createResult.sessionState === "attached") {
    return {
      ptyId,
      launchCwd: pane.launchCwd,
      initialScrollback: createResult.initialHydration?.text,
      initialScrollbackSource:
        createResult.initialHydration?.source === "tmuxCapture" ? "tmuxCapture" : undefined,
    };
  }

  return {
    ptyId,
    launchCwd: pane.launchCwd,
    initialScrollback: pane.scrollback || undefined,
    initialScrollbackSource: pane.scrollback ? "snapshotFallback" : undefined,
  };
}
