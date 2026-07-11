import { useShallow } from "zustand/react/shallow";
import { collectSessionPanes } from "../../lib/terminal-session";
import type { WorktreeTerminalSession } from "../../types";
import type { AiSession } from "../../store/terminal";
import { useTerminalStore } from "../../store/terminal";

const EMPTY_SESSIONS: AiSession[] = [];

interface WorktreeStatusState {
  sessions: Record<string, WorktreeTerminalSession>;
  bellPtyIds: Set<string>;
  aiSessions: Record<string, AiSession>;
}

export function selectAiWorktreeSessions(
  state: WorktreeStatusState,
  worktreePath: string,
): AiSession[] {
  const session = state.sessions[worktreePath];
  if (!session) {
    return EMPTY_SESSIONS;
  }

  const result: AiSession[] = [];
  for (const { ptyId } of collectSessionPanes(session)) {
    const ai = ptyId ? state.aiSessions[ptyId] : undefined;
    if (ai) result.push(ai);
  }
  return result.length > 0 ? result : EMPTY_SESSIONS;
}

export function useAiWorktreeSessions(worktreePath: string): AiSession[] {
  return useTerminalStore(useShallow((state) => selectAiWorktreeSessions(state, worktreePath)));
}

export function selectWorktreeBell(state: WorktreeStatusState, worktreePath: string): boolean {
  const session = state.sessions[worktreePath];
  if (!session || state.bellPtyIds.size === 0) {
    return false;
  }

  return collectSessionPanes(session).some(({ ptyId }) => !!ptyId && state.bellPtyIds.has(ptyId));
}

export function useWorktreeBell(worktreePath: string): boolean {
  return useTerminalStore((state) => selectWorktreeBell(state, worktreePath));
}
