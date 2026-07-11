import { create } from "zustand";
import type { SplitNode, TerminalTheme } from "../types";
import {
  toLayoutTemplate,
  countLeaves,
  splitNode,
  removeNode,
  setSizesAtPath,
  normalizeSplitTree,
  setLeafLabel,
} from "../lib/split-tree";
import {
  collectTerminalPanes,
  findFirstTerminalPane,
  findTerminalPaneByPaneId,
  findTerminalPaneByPtyId,
  findWorktreePathForPtyId,
} from "../lib/terminal-session";
import { loadTerminalLayouts, saveTerminalLayouts } from "../lib/platform";

// In-memory cache populated at startup via initLayouts()
let layoutCache: Record<string, SplitNode> = {};

// Debounced save to Rust file backend — MERGES with existing saved layouts
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function saveLayouts(sessions: Record<string, SplitNode>) {
  // Merge current sessions into existing cache (don't wipe other worktree layouts)
  for (const [path, node] of Object.entries(sessions)) {
    layoutCache[path] = toLayoutTemplate(node);
  }
  // Remove layouts for sessions that were explicitly deleted (0 leaves)
  for (const path of Object.keys(layoutCache)) {
    if (sessions[path] === undefined && Object.keys(sessions).length > 0) {
      // Don't delete — session might just not be active right now
    }
  }

  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTerminalLayouts(JSON.stringify(layoutCache)).catch(console.error);
  }, 500);
}

// ── Store ──

export type AiTool = "claude" | "codex";
export type AiStatus = "running" | "idle" | "attention";
export interface AiSession {
  tool: AiTool;
  status: AiStatus;
}

/** @deprecated Use AiSession instead */
export type ClaudeSessionStatus = AiStatus;

interface TerminalState {
  sessions: Record<string, SplitNode>;
  activeWorktree: string | null;
  focusedPtyId: string | null;
  focusedPaneIdByWorktree: Record<string, string | null>;
  bellPtyIds: Set<string>;
  aiSessions: Record<string, AiSession>;
  theme: TerminalTheme | null;
  detectedTheme: TerminalTheme | null;
  createSession: (worktreePath: string, paneId: string, ptyId: string) => void;
  restoreSession: (worktreePath: string, node: SplitNode) => void;
  splitTerminal: (
    worktreePath: string,
    ptyId: string,
    direction: "horizontal" | "vertical",
    newPaneId: string,
    newPtyId: string,
  ) => void;
  closeTerminal: (worktreePath: string, ptyId: string) => void;
  setActiveWorktree: (worktreePath: string | null) => void;
  setFocusedPtyId: (ptyId: string | null) => void;
  markBellPty: (ptyId: string) => void;
  updateAiStatus: (ptyId: string, raw: string | null) => void;
  setDetectedTheme: (theme: TerminalTheme) => void;
  loadTheme: (theme: TerminalTheme) => void;
  removeSession: (worktreePath: string, nextActiveWorktree?: string | null) => void;
  updateSizes: (worktreePath: string, nodePath: number[], ratios: number[]) => void;
  setPaneLabel: (worktreePath: string, paneId: string, label: string | undefined) => void;
  getSavedLayout: (worktreePath: string) => SplitNode | null;
  initLayouts: () => Promise<void>;
}

function sessionContainsPty(node: SplitNode | undefined, ptyId: string): boolean {
  return !!node && collectTerminalPanes(node).some((pane) => pane.ptyId === ptyId);
}

function clearAttentionForPty(
  aiSessions: Record<string, AiSession>,
  ptyId: string | null,
): Record<string, AiSession> {
  if (!ptyId) {
    return aiSessions;
  }

  const session = aiSessions[ptyId];
  if (!session || session.status !== "attention") {
    return aiSessions;
  }

  return {
    ...aiSessions,
    [ptyId]: { ...session, status: "idle" },
  };
}
interface WorktreeFocus {
  paneId: string | null;
  ptyId: string | null;
}

function setFocusedPaneForWorktree(
  focusedPaneIdByWorktree: Record<string, string | null>,
  worktreePath: string,
  paneId: string | null,
): Record<string, string | null> {
  if (paneId === null) {
    if (!(worktreePath in focusedPaneIdByWorktree)) {
      return focusedPaneIdByWorktree;
    }
    const next = { ...focusedPaneIdByWorktree };
    delete next[worktreePath];
    return next;
  }

  if (focusedPaneIdByWorktree[worktreePath] === paneId) {
    return focusedPaneIdByWorktree;
  }

  return {
    ...focusedPaneIdByWorktree,
    [worktreePath]: paneId,
  };
}

function resolveWorktreeFocus(
  node: SplitNode | undefined,
  rememberedPaneId: string | null | undefined,
): WorktreeFocus {
  if (!node) {
    return { paneId: null, ptyId: null };
  }

  if (rememberedPaneId) {
    const rememberedPane = findTerminalPaneByPaneId(node, rememberedPaneId);
    if (rememberedPane?.ptyId) {
      return {
        paneId: rememberedPane.paneId,
        ptyId: rememberedPane.ptyId,
      };
    }
  }

  const firstPane = findFirstTerminalPane(node);
  return {
    paneId: firstPane?.paneId ?? null,
    ptyId: firstPane?.ptyId ?? null,
  };
}

function shouldSyncActiveFocus(activeWorktree: string | null, targetWorktree: string): boolean {
  return activeWorktree === null || activeWorktree === targetWorktree;
}
export const useTerminalStore = create<TerminalState>((set) => ({
  sessions: {},
  activeWorktree: null,
  focusedPtyId: null,
  focusedPaneIdByWorktree: {},
  bellPtyIds: new Set<string>(),
  aiSessions: {},
  theme: null,
  detectedTheme: null,

  getSavedLayout: (worktreePath) => {
    const template = layoutCache[worktreePath];
    if (!template || countLeaves(template) === 0) return null;
    return template;
  },

  createSession: (worktreePath, paneId, ptyId) =>
    set((state) => {
      const focus = { paneId, ptyId };
      const newSessions = {
        ...state.sessions,
        [worktreePath]: { id: paneId, type: "leaf" as const, ptyId },
      };
      saveLayouts(newSessions);
      return {
        sessions: newSessions,
        focusedPaneIdByWorktree: setFocusedPaneForWorktree(
          state.focusedPaneIdByWorktree,
          worktreePath,
          focus.paneId,
        ),
        focusedPtyId: shouldSyncActiveFocus(state.activeWorktree, worktreePath)
          ? focus.ptyId
          : state.focusedPtyId,
      };
    }),

  restoreSession: (worktreePath, node) =>
    set((state) => {
      const restored = normalizeSplitTree(node, () => crypto.randomUUID());
      const focus = resolveWorktreeFocus(restored, state.focusedPaneIdByWorktree[worktreePath]);
      const newSessions = { ...state.sessions, [worktreePath]: restored };
      saveLayouts(newSessions);
      return {
        sessions: newSessions,
        focusedPaneIdByWorktree: setFocusedPaneForWorktree(
          state.focusedPaneIdByWorktree,
          worktreePath,
          focus.paneId,
        ),
        focusedPtyId: shouldSyncActiveFocus(state.activeWorktree, worktreePath)
          ? focus.ptyId
          : state.focusedPtyId,
      };
    }),

  splitTerminal: (worktreePath, ptyId, direction, newPaneId, newPtyId) =>
    set((state) => {
      const root = state.sessions[worktreePath];
      if (!root) return state;
      const focus = { paneId: newPaneId, ptyId: newPtyId };
      const newSessions = {
        ...state.sessions,
        [worktreePath]: splitNode(root, ptyId, direction, {
          branchId: crypto.randomUUID(),
          leafId: newPaneId,
          ptyId: newPtyId,
        }),
      };
      saveLayouts(newSessions);
      return {
        sessions: newSessions,
        focusedPaneIdByWorktree: setFocusedPaneForWorktree(
          state.focusedPaneIdByWorktree,
          worktreePath,
          focus.paneId,
        ),
        focusedPtyId: shouldSyncActiveFocus(state.activeWorktree, worktreePath)
          ? focus.ptyId
          : state.focusedPtyId,
      };
    }),

  removeSession: (worktreePath, nextActiveWorktree = null) =>
    set((state) => {
      const newSessions = { ...state.sessions };
      const nextBellPtyIds = new Set(state.bellPtyIds);
      let nextAiSessions = { ...state.aiSessions };
      const existingSession = state.sessions[worktreePath];
      if (existingSession) {
        for (const { ptyId } of collectTerminalPanes(existingSession)) {
          if (ptyId) {
            nextBellPtyIds.delete(ptyId);
            delete nextAiSessions[ptyId];
          }
        }
      }
      delete newSessions[worktreePath];
      delete layoutCache[worktreePath];
      saveLayouts(newSessions);

      let nextFocusedPaneIdByWorktree = setFocusedPaneForWorktree(
        state.focusedPaneIdByWorktree,
        worktreePath,
        null,
      );

      const shouldSwitchActiveWorktree = state.activeWorktree === worktreePath;
      const resolvedActiveWorktree = shouldSwitchActiveWorktree
        ? nextActiveWorktree
        : state.activeWorktree;
      const activeSession = resolvedActiveWorktree
        ? newSessions[resolvedActiveWorktree]
        : undefined;
      const nextActiveFocus = resolveWorktreeFocus(
        activeSession,
        resolvedActiveWorktree ? nextFocusedPaneIdByWorktree[resolvedActiveWorktree] : null,
      );

      if (resolvedActiveWorktree) {
        nextFocusedPaneIdByWorktree = setFocusedPaneForWorktree(
          nextFocusedPaneIdByWorktree,
          resolvedActiveWorktree,
          nextActiveFocus.paneId,
        );
      }

      if (activeSession) {
        for (const { ptyId } of collectTerminalPanes(activeSession)) {
          if (!ptyId) {
            continue;
          }
          nextBellPtyIds.delete(ptyId);
          const session = nextAiSessions[ptyId];
          if (session?.status === "attention") {
            nextAiSessions[ptyId] = { ...session, status: "idle" };
          }
        }
      }

      return {
        sessions: newSessions,
        bellPtyIds: nextBellPtyIds,
        aiSessions: nextAiSessions,
        focusedPaneIdByWorktree: nextFocusedPaneIdByWorktree,
        focusedPtyId: shouldSwitchActiveWorktree ? nextActiveFocus.ptyId : state.focusedPtyId,
        activeWorktree: resolvedActiveWorktree,
      };
    }),

  closeTerminal: (worktreePath, ptyId) =>
    set((state) => {
      const root = state.sessions[worktreePath];
      if (!root) return state;
      const updated = removeNode(root, ptyId);
      const newSessions = { ...state.sessions };
      if (updated) {
        newSessions[worktreePath] = updated;
      } else {
        delete newSessions[worktreePath];
      }
      saveLayouts(newSessions);
      const nextFocus = resolveWorktreeFocus(
        updated ?? undefined,
        state.focusedPaneIdByWorktree[worktreePath],
      );
      const nextBellPtyIds = new Set(state.bellPtyIds);
      nextBellPtyIds.delete(ptyId);
      const nextAiSessions = { ...state.aiSessions };
      delete nextAiSessions[ptyId];
      return {
        sessions: newSessions,
        focusedPaneIdByWorktree: setFocusedPaneForWorktree(
          state.focusedPaneIdByWorktree,
          worktreePath,
          nextFocus.paneId,
        ),
        focusedPtyId: state.activeWorktree === worktreePath ? nextFocus.ptyId : state.focusedPtyId,
        bellPtyIds: nextBellPtyIds,
        aiSessions: nextAiSessions,
      };
    }),

  setActiveWorktree: (worktreePath) =>
    set((state) => {
      const nextFocus = worktreePath
        ? resolveWorktreeFocus(
            state.sessions[worktreePath],
            state.focusedPaneIdByWorktree[worktreePath],
          )
        : { paneId: null, ptyId: null };
      let nextFocusedPaneIdByWorktree = state.focusedPaneIdByWorktree;
      if (worktreePath) {
        nextFocusedPaneIdByWorktree = setFocusedPaneForWorktree(
          state.focusedPaneIdByWorktree,
          worktreePath,
          nextFocus.paneId,
        );
      }
      const nextBellPtyIds = new Set(state.bellPtyIds);
      let nextAiSessions = state.aiSessions;
      if (worktreePath && state.sessions[worktreePath]) {
        for (const { ptyId } of collectTerminalPanes(state.sessions[worktreePath])) {
          if (ptyId) {
            nextBellPtyIds.delete(ptyId);
            const session = state.aiSessions[ptyId];
            if (session?.status === "attention") {
              if (nextAiSessions === state.aiSessions) {
                nextAiSessions = { ...state.aiSessions };
              }
              nextAiSessions[ptyId] = { ...session, status: "idle" };
            }
          }
        }
      }
      return {
        activeWorktree: worktreePath,
        focusedPaneIdByWorktree: nextFocusedPaneIdByWorktree,
        focusedPtyId: nextFocus.ptyId,
        bellPtyIds: nextBellPtyIds,
        aiSessions: nextAiSessions,
      };
    }),

  setFocusedPtyId: (ptyId) =>
    set((state) => {
      if (!ptyId) {
        return state.focusedPtyId === null ? state : { focusedPtyId: null };
      }

      const nextAiSessions = clearAttentionForPty(state.aiSessions, ptyId);
      const activeSession = state.activeWorktree ? state.sessions[state.activeWorktree] : undefined;
      const activePane = activeSession ? findTerminalPaneByPtyId(activeSession, ptyId) : null;
      const worktreePath = activePane
        ? state.activeWorktree
        : findWorktreePathForPtyId(state.sessions, ptyId);

      if (!worktreePath) {
        if (state.focusedPtyId === ptyId && nextAiSessions === state.aiSessions) {
          return state;
        }
        return { focusedPtyId: ptyId, aiSessions: nextAiSessions };
      }

      const pane = findTerminalPaneByPtyId(state.sessions[worktreePath], ptyId);
      if (!pane) {
        if (state.focusedPtyId === ptyId && nextAiSessions === state.aiSessions) {
          return state;
        }
        return { focusedPtyId: ptyId, aiSessions: nextAiSessions };
      }

      return {
        focusedPtyId: ptyId,
        aiSessions: nextAiSessions,
        focusedPaneIdByWorktree: setFocusedPaneForWorktree(
          state.focusedPaneIdByWorktree,
          worktreePath,
          pane.paneId,
        ),
      };
    }),

  markBellPty: (ptyId) =>
    set((state) => {
      if (state.bellPtyIds.has(ptyId)) {
        return state;
      }

      return {
        bellPtyIds: new Set(state.bellPtyIds).add(ptyId),
      };
    }),

  updateAiStatus: (ptyId, raw) =>
    set((state) => {
      if (raw) {
        const [tool, nextStatus] = raw.split(":") as [AiTool, AiStatus];
        let status = nextStatus;
        if (!tool || !status) return state;
        if (
          status === "attention" &&
          sessionContainsPty(
            state.activeWorktree ? state.sessions[state.activeWorktree] : undefined,
            ptyId,
          )
        ) {
          status = "idle";
        }
        const prev = state.aiSessions[ptyId];
        if (prev && prev.tool === tool && prev.status === status) return state;
        return { aiSessions: { ...state.aiSessions, [ptyId]: { tool, status } } };
      }
      if (!(ptyId in state.aiSessions)) return state;
      const next = { ...state.aiSessions };
      delete next[ptyId];
      return { aiSessions: next };
    }),

  updateSizes: (worktreePath, nodePath, ratios) =>
    set((state) => {
      const root = state.sessions[worktreePath];
      if (!root) return state;
      const updated = setSizesAtPath(root, nodePath, ratios);
      const newSessions = { ...state.sessions, [worktreePath]: updated };
      saveLayouts(newSessions);
      return { sessions: newSessions };
    }),

  setPaneLabel: (worktreePath, paneId, label) =>
    set((state) => {
      const root = state.sessions[worktreePath];
      if (!root) return state;
      const updated = setLeafLabel(root, paneId, label);
      if (updated === root) return state;
      const newSessions = { ...state.sessions, [worktreePath]: updated };
      saveLayouts(newSessions);
      return { sessions: newSessions };
    }),

  setDetectedTheme: (theme) => set({ detectedTheme: theme }),
  loadTheme: (theme) => set({ theme }),

  initLayouts: async () => {
    try {
      const raw = await loadTerminalLayouts();
      const parsed = JSON.parse(raw) as Record<string, SplitNode>;
      layoutCache = Object.fromEntries(
        Object.entries(parsed).map(([worktreePath, node]) => [
          worktreePath,
          normalizeSplitTree(node, () => crypto.randomUUID()),
        ]),
      );
    } catch {
      layoutCache = {};
    }
  },
}));

export { countLeaves, assignPtyIds } from "../lib/split-tree";
