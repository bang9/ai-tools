import { memo, useEffect, useRef, useState } from "react";
import { TerminalSquare } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useTerminalStore } from "../../store/terminal";
import { useResolvedSidebarSelection } from "../../hooks/useResolvedSidebarSelection";
import {
  getTerminalTheme,
  getAppConfig,
  getCommandErrorMessage,
  pollPtyBells,
  saveTerminalSessionSnapshot,
} from "../../lib/platform";
import { runCommand } from "../../lib/command";
import { useTerminal } from "../../hooks/useTerminal";
import SplitContainer from "./SplitContainer";
import { log, error as logError } from "../../lib/logger";
import {
  buildTerminalPaneTopologySignature,
  buildTerminalSnapshotRequest,
  collectSessionPanes,
} from "../../lib/terminal-session";
import {
  getTerminalPaneLaunchCwd,
  subscribeTerminalPaneActivity,
} from "../../lib/terminal-runtime";
import { registerSyncJob, unregisterSyncJob } from "../../lib/sync-manager";
import { cn } from "../../lib/cn";
import type { WorktreeTerminalSession } from "../../types";

const SNAPSHOT_SAVE_DEBOUNCE_MS = 750;
const PTY_BELL_POLL_MS = 1000;
const PTY_BELL_STATUS_JOB_KEY = "pty-bell-status";

function buildPaneTopologySignatures(sessions: Record<string, WorktreeTerminalSession>) {
  const signatures = new Map<string, string>();

  for (const [worktreePath, session] of Object.entries(sessions)) {
    const signature = buildTerminalPaneTopologySignature(session);
    if (signature) {
      signatures.set(worktreePath, signature);
    }
  }

  return signatures;
}

/**
 * Inverted index for O(1) ptyId -> worktreePath lookups on the per-chunk
 * activity path. Rebuilt wholesale from the sessions tree (rather than
 * mutated incrementally) so a rebound ptyId never resolves to a stale
 * worktree after a split-tree move.
 */
export function buildPtyIdToWorktreeIndex(sessions: Record<string, WorktreeTerminalSession>) {
  const index = new Map<string, string>();

  for (const [worktreePath, session] of Object.entries(sessions)) {
    for (const pane of collectSessionPanes(session)) {
      if (pane.ptyId) {
        index.set(pane.ptyId, worktreePath);
      }
    }
  }

  return index;
}

const TerminalSessionView = memo(function TerminalSessionView({
  worktreePath,
}: {
  worktreePath: string;
}) {
  const isActive = useTerminalStore((s) => s.activeWorktree === worktreePath);
  const session = useTerminalStore((s) => s.sessions[worktreePath] ?? null);

  if (!session) {
    return null;
  }

  return (
    <div className={cn("absolute inset-0")} style={{ display: isActive ? "block" : "none" }}>
      {session.tabs.map((tab) => (
        <div
          key={tab.id}
          className={cn("absolute inset-0")}
          style={{ display: tab.id === session.activeTabId ? "block" : "none" }}
        >
          <SplitContainer node={tab.node} worktreePath={worktreePath} tabId={tab.id} />
        </div>
      ))}
    </div>
  );
});

function TerminalPanel() {
  const worktreePaths = useTerminalStore(useShallow((s) => Object.keys(s.sessions)));
  const activeWorktree = useTerminalStore((s) => s.activeWorktree);
  const hasActiveSession = useTerminalStore((s) =>
    s.activeWorktree ? s.sessions[s.activeWorktree] !== undefined : false,
  );
  const theme = useTerminalStore((s) => s.theme);
  const loadTheme = useTerminalStore((s) => s.loadTheme);
  const setDetectedTheme = useTerminalStore((s) => s.setDetectedTheme);
  const setActiveWorktree = useTerminalStore((s) => s.setActiveWorktree);
  const updateAiStatus = useTerminalStore((s) => s.updateAiStatus);
  const { terminalPath } = useResolvedSidebarSelection();
  const { createTerminal } = useTerminal();
  const [error, setError] = useState<string | null>(null);
  const previousPaneTopologyRef = useRef(new Map<string, string>());
  const snapshotSaveTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const sessionsRef = useRef(useTerminalStore.getState().sessions);
  const ptyIdToWorktreeRef = useRef(new Map<string, string>());

  const persistSnapshot = (worktreePath: string) => {
    const session = sessionsRef.current[worktreePath];
    void saveTerminalSessionSnapshot(
      buildTerminalSnapshotRequest(
        worktreePath,
        session,
        new Map(
          collectSessionPanes(session).map((pane) => [
            pane.paneId,
            getTerminalPaneLaunchCwd(pane.paneId) ?? worktreePath,
          ]),
        ),
      ),
    ).catch((cause) => {
      logError("terminal", "fallback snapshot save failed", {
        worktreePath,
        cause,
      });
    });
  };

  const scheduleSnapshotSave = (worktreePath: string) => {
    const timers = snapshotSaveTimersRef.current;
    const existing = timers.get(worktreePath);
    if (existing) {
      clearTimeout(existing);
    }

    timers.set(
      worktreePath,
      setTimeout(() => {
        timers.delete(worktreePath);
        persistSnapshot(worktreePath);
      }, SNAPSHOT_SAVE_DEBOUNCE_MS),
    );
  };

  useEffect(() => {
    const initialSessions = useTerminalStore.getState().sessions;
    sessionsRef.current = initialSessions;
    previousPaneTopologyRef.current = buildPaneTopologySignatures(initialSessions);
    ptyIdToWorktreeRef.current = buildPtyIdToWorktreeIndex(initialSessions);

    return useTerminalStore.subscribe((state, previousState) => {
      if (state.sessions === previousState.sessions) {
        return;
      }

      sessionsRef.current = state.sessions;
      ptyIdToWorktreeRef.current = buildPtyIdToWorktreeIndex(state.sessions);

      const previous = previousPaneTopologyRef.current;
      const next = buildPaneTopologySignatures(state.sessions);
      const changedPaths = new Set<string>([...previous.keys(), ...Object.keys(state.sessions)]);

      for (const worktreePath of changedPaths) {
        const nextSignature = next.get(worktreePath);
        if (previous.has(worktreePath) && previous.get(worktreePath) !== nextSignature) {
          scheduleSnapshotSave(worktreePath);
        }
      }

      previousPaneTopologyRef.current = next;
    });
  }, []);

  useEffect(
    () =>
      subscribeTerminalPaneActivity(({ ptyId }) => {
        const worktreePath = ptyIdToWorktreeRef.current.get(ptyId);
        if (!worktreePath) {
          return;
        }

        scheduleSnapshotSave(worktreePath);
      }),
    [],
  );

  useEffect(
    () => () => {
      for (const [worktreePath, timer] of snapshotSaveTimersRef.current.entries()) {
        clearTimeout(timer);
        persistSnapshot(worktreePath);
      }
      snapshotSaveTimersRef.current.clear();
    },
    [],
  );

  // Load theme + default worktree
  useEffect(() => {
    async function init() {
      try {
        log("terminal", "init start");
        await useTerminalStore.getState().initLayouts();
        log("terminal", "layouts loaded");

        const config = await runCommand(() => getAppConfig(), {
          errorToast: false,
        });
        log("terminal", "config loaded", { hasTerminalTheme: !!config.terminalTheme });

        log("terminal", "detecting system theme...");
        const result = await runCommand(() => getTerminalTheme(), {
          errorToast: false,
        });
        log("terminal", "system theme result", {
          detected: result.detected,
          bg: result.theme.background,
          fg: result.theme.foreground,
        });

        // Only expose System preset if detection actually succeeded
        if (result.detected) {
          setDetectedTheme(result.theme);
        }

        if (config.terminalTheme) {
          const merged = { ...result.theme, ...config.terminalTheme };
          log("terminal", "using saved theme override", { bg: merged.background });
          loadTheme(merged);
        } else {
          log("terminal", "using detected theme");
          loadTheme(result.theme);
        }
        log("terminal", "init complete");
      } catch (e) {
        logError("terminal", "init failed", e);
        setError(getCommandErrorMessage(e));
      }
    }
    init();
  }, []);

  // Sync sidebar selection -> terminal session target
  useEffect(() => {
    setActiveWorktree(terminalPath);
  }, [terminalPath, setActiveWorktree]);

  useEffect(() => {
    const pollBellEvents = async () => {
      if (Object.keys(sessionsRef.current).length === 0) {
        return;
      }

      try {
        const events = await pollPtyBells();
        for (const { ptyId, aiStatus } of events) {
          updateAiStatus(ptyId, aiStatus);
        }
      } catch {
        // Ignore bell polling errors to avoid noisy UI while sessions churn.
      }
    };

    registerSyncJob(PTY_BELL_STATUS_JOB_KEY, pollBellEvents, PTY_BELL_POLL_MS);

    return () => unregisterSyncJob(PTY_BELL_STATUS_JOB_KEY);
  }, [updateAiStatus]);

  // Create session for new worktree
  useEffect(() => {
    if (!activeWorktree || !theme) {
      log("terminal", "skip session create", { activeWorktree, hasTheme: !!theme });
      return;
    }
    if (hasActiveSession) {
      log("terminal", "session exists", activeWorktree);
      return;
    }
    log("terminal", "creating session", activeWorktree);
    createTerminal(activeWorktree).catch((e) => {
      logError("terminal", "session create failed", e);
      setError(getCommandErrorMessage(e));
    });
  }, [activeWorktree, createTerminal, hasActiveSession, theme]);

  if (error) {
    return (
      <div className={cn("flex items-center justify-center h-full bg-background")}>
        <span className={cn("text-sm text-destructive px-4")}>Error: {error}</span>
      </div>
    );
  }

  if (!theme) {
    return (
      <div className={cn("flex items-center justify-center h-full bg-background")}>
        <span className={cn("text-sm text-muted-foreground")}>Loading...</span>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col h-full bg-background")}>
      <div className={cn("flex-1 relative overflow-hidden")}>
        {!activeWorktree ? (
          <div className={cn("flex flex-col items-center justify-center h-full gap-3")}>
            <TerminalSquare className={cn("size-10 text-muted-foreground/50")} />
            <span className={cn("text-sm text-muted-foreground")}>
              Select a worktree to open terminal
            </span>
          </div>
        ) : (
          worktreePaths.map((path) => <TerminalSessionView key={path} worktreePath={path} />)
        )}
      </div>
    </div>
  );
}

export default memo(TerminalPanel);
