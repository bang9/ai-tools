import { runCommandSafely, type CommandOptions } from "./command";
import { runTerminalGc, type TerminalGcReport } from "./platform";
import { useTerminalStore } from "../store/terminal";

export const TERMINAL_GC_JOB_KEY = "terminal-gc";
export const TERMINAL_GC_INTERVAL_MS = 15 * 60 * 1000;

let activeRun: Promise<TerminalGcReport | null> | null = null;

function syncTerminalStore(report: TerminalGcReport) {
  const store = useTerminalStore.getState();
  for (const worktreePath of report.prunedWorktreePaths) {
    store.removeSession(worktreePath);
  }
}

export async function runTerminalGcNow(
  dryRun = false,
  options?: CommandOptions,
): Promise<TerminalGcReport | null> {
  if (activeRun) {
    return activeRun;
  }

  activeRun = runCommandSafely(() => runTerminalGc(dryRun), {
    errorToast: options?.errorToast ?? false,
  })
    .then((report) => {
      if (report && !dryRun) {
        syncTerminalStore(report);
      }
      return report;
    })
    .finally(() => {
      activeRun = null;
    });

  return activeRun;
}
