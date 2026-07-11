import { create } from "zustand";
import type { SplitNode, TerminalTab, TerminalTheme, WorktreeTerminalSession } from "../types";
import {
  toLayoutTemplate,
  splitNode,
  removeNode,
  setSizesAtPath,
  normalizeSplitTree,
  setLeafLabel,
} from "../lib/split-tree";
import {
  collectSessionPanes,
  collectTerminalPanes,
  findActiveTab,
  findFirstTerminalPane,
  findTabByPaneId,
  findTabByPtyId,
  findTerminalPaneByPaneId,
  findTerminalPaneByPtyId,
} from "../lib/terminal-session";
import { loadTerminalLayouts, saveTerminalLayouts } from "../lib/platform";

// In-memory cache populated at startup via initLayouts()
let layoutCache: Record<string, WorktreeTerminalSession> = {};

interface PersistedTerminalTab {
  id?: string;
  node?: SplitNode;
}

interface PersistedWorktreeSession {
  tabs?: PersistedTerminalTab[];
  activeTabId?: string;
}

/**
 * Saved layouts hold either the tabbed session shape or, for files written
 * before terminal tabs existed, a bare SplitNode — wrap those in a single tab.
 */
function normalizeSavedSession(
  value: PersistedWorktreeSession | SplitNode,
  createId: () => string,
): WorktreeTerminalSession | null {
  if ("type" in value) {
    const node = normalizeSplitTree(value, createId);
    const tabId = createId();
    return { tabs: [{ id: tabId, node }], activeTabId: tabId };
  }

  const tabs: TerminalTab[] = [];
  for (const tab of value.tabs ?? []) {
    if (!tab.node) {
      continue;
    }
    tabs.push({
      id: tab.id ?? createId(),
      node: normalizeSplitTree(tab.node, createId),
    });
  }
  if (tabs.length === 0) {
    return null;
  }

  const activeTabId = tabs.some((tab) => tab.id === value.activeTabId)
    ? (value.activeTabId as string)
    : tabs[0].id;
  return { tabs, activeTabId };
}

function toSessionTemplate(session: WorktreeTerminalSession): WorktreeTerminalSession {
  return {
    tabs: session.tabs.map((tab) => ({ id: tab.id, node: toLayoutTemplate(tab.node) })),
    activeTabId: session.activeTabId,
  };
}

// Debounced save to Rust file backend — MERGES with existing saved layouts
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function saveLayouts(sessions: Record<string, WorktreeTerminalSession>) {
  // Merge current sessions into existing cache (don't wipe other worktree layouts)
  for (const [path, session] of Object.entries(sessions)) {
    layoutCache[path] = toSessionTemplate(session);
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
  sessions: Record<string, WorktreeTerminalSession>;
  activeWorktree: string | null;
  focusedPtyId: string | null;
  /** Remembered focused pane per terminal tab (tab ids are globally unique). */
  focusedPaneIdByTab: Record<string, string | null>;
  bellPtyIds: Set<string>;
  aiSessions: Record<string, AiSession>;
  theme: TerminalTheme | null;
  detectedTheme: TerminalTheme | null;
  createSession: (worktreePath: string, paneId: string, ptyId: string) => void;
  restoreSession: (worktreePath: string, session: WorktreeTerminalSession) => void;
  splitTerminal: (
    worktreePath: string,
    ptyId: string,
    direction: "horizontal" | "vertical",
    newPaneId: string,
    newPtyId: string,
  ) => void;
  closeTerminal: (worktreePath: string, ptyId: string) => void;
  addTab: (worktreePath: string, paneId: string, ptyId: string) => void;
  setActiveTab: (worktreePath: string, tabId: string) => void;
  closeTab: (worktreePath: string, tabId: string) => void;
  setActiveWorktree: (worktreePath: string | null) => void;
  setFocusedPtyId: (ptyId: string | null) => void;
  markBellPty: (ptyId: string) => void;
  updateAiStatus: (ptyId: string, raw: string | null) => void;
  setDetectedTheme: (theme: TerminalTheme) => void;
  loadTheme: (theme: TerminalTheme) => void;
  removeSession: (worktreePath: string, nextActiveWorktree?: string | null) => void;
  updateSizes: (worktreePath: string, tabId: string, nodePath: number[], ratios: number[]) => void;
  setPaneLabel: (worktreePath: string, paneId: string, label: string | undefined) => void;
  getSavedLayout: (worktreePath: string) => WorktreeTerminalSession | null;
  initLayouts: () => Promise<void>;
}

/** Panes of the tab the user actually sees: active worktree's active tab. */
function visibleTabPanes(state: {
  sessions: Record<string, WorktreeTerminalSession>;
  activeWorktree: string | null;
}) {
  const session = state.activeWorktree ? state.sessions[state.activeWorktree] : undefined;
  const tab = findActiveTab(session);
  return tab ? collectTerminalPanes(tab.node) : [];
}

function visibleTabContainsPty(
  state: { sessions: Record<string, WorktreeTerminalSession>; activeWorktree: string | null },
  ptyId: string,
): boolean {
  return visibleTabPanes(state).some((pane) => pane.ptyId === ptyId);
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

interface TabFocus {
  paneId: string | null;
  ptyId: string | null;
}

function setFocusedPaneForTab(
  focusedPaneIdByTab: Record<string, string | null>,
  tabId: string,
  paneId: string | null,
): Record<string, string | null> {
  if (paneId === null) {
    if (!(tabId in focusedPaneIdByTab)) {
      return focusedPaneIdByTab;
    }
    const next = { ...focusedPaneIdByTab };
    delete next[tabId];
    return next;
  }

  if (focusedPaneIdByTab[tabId] === paneId) {
    return focusedPaneIdByTab;
  }

  return {
    ...focusedPaneIdByTab,
    [tabId]: paneId,
  };
}

function dropTabFocusEntries(
  focusedPaneIdByTab: Record<string, string | null>,
  tabIds: string[],
): Record<string, string | null> {
  if (!tabIds.some((tabId) => tabId in focusedPaneIdByTab)) {
    return focusedPaneIdByTab;
  }
  const next = { ...focusedPaneIdByTab };
  for (const tabId of tabIds) {
    delete next[tabId];
  }
  return next;
}

function resolveTabFocus(
  tab: TerminalTab | null,
  rememberedPaneId: string | null | undefined,
): TabFocus {
  if (!tab) {
    return { paneId: null, ptyId: null };
  }

  if (rememberedPaneId) {
    const rememberedPane = findTerminalPaneByPaneId(tab.node, rememberedPaneId);
    if (rememberedPane?.ptyId) {
      return {
        paneId: rememberedPane.paneId,
        ptyId: rememberedPane.ptyId,
      };
    }
  }

  const firstPane = findFirstTerminalPane(tab.node);
  return {
    paneId: firstPane?.paneId ?? null,
    ptyId: firstPane?.ptyId ?? null,
  };
}

function resolveSessionFocus(
  session: WorktreeTerminalSession | undefined,
  focusedPaneIdByTab: Record<string, string | null>,
): TabFocus {
  const tab = findActiveTab(session);
  return resolveTabFocus(tab, tab ? focusedPaneIdByTab[tab.id] : null);
}

function replaceTabNode(
  session: WorktreeTerminalSession,
  tabId: string,
  node: SplitNode,
): WorktreeTerminalSession {
  return {
    ...session,
    tabs: session.tabs.map((tab) => (tab.id === tabId ? { ...tab, node } : tab)),
  };
}

function shouldSyncActiveFocus(activeWorktree: string | null, targetWorktree: string): boolean {
  return activeWorktree === null || activeWorktree === targetWorktree;
}

export const useTerminalStore = create<TerminalState>((set) => ({
  sessions: {},
  activeWorktree: null,
  focusedPtyId: null,
  focusedPaneIdByTab: {},
  bellPtyIds: new Set<string>(),
  aiSessions: {},
  theme: null,
  detectedTheme: null,

  getSavedLayout: (worktreePath) => {
    const template = layoutCache[worktreePath];
    if (!template || collectSessionPanes(template).length === 0) return null;
    return template;
  },

  createSession: (worktreePath, paneId, ptyId) =>
    set((state) => {
      const tabId = crypto.randomUUID();
      const session: WorktreeTerminalSession = {
        tabs: [{ id: tabId, node: { id: paneId, type: "leaf", ptyId } }],
        activeTabId: tabId,
      };
      const newSessions = { ...state.sessions, [worktreePath]: session };
      saveLayouts(newSessions);
      return {
        sessions: newSessions,
        focusedPaneIdByTab: setFocusedPaneForTab(state.focusedPaneIdByTab, tabId, paneId),
        focusedPtyId: shouldSyncActiveFocus(state.activeWorktree, worktreePath)
          ? ptyId
          : state.focusedPtyId,
      };
    }),

  restoreSession: (worktreePath, session) =>
    set((state) => {
      const restored: WorktreeTerminalSession = {
        tabs: session.tabs.map((tab) => ({
          id: tab.id,
          node: normalizeSplitTree(tab.node, () => crypto.randomUUID()),
        })),
        activeTabId: session.activeTabId,
      };
      const focus = resolveSessionFocus(restored, state.focusedPaneIdByTab);
      const newSessions = { ...state.sessions, [worktreePath]: restored };
      saveLayouts(newSessions);
      const activeTab = findActiveTab(restored);
      return {
        sessions: newSessions,
        focusedPaneIdByTab: activeTab
          ? setFocusedPaneForTab(state.focusedPaneIdByTab, activeTab.id, focus.paneId)
          : state.focusedPaneIdByTab,
        focusedPtyId: shouldSyncActiveFocus(state.activeWorktree, worktreePath)
          ? focus.ptyId
          : state.focusedPtyId,
      };
    }),

  splitTerminal: (worktreePath, ptyId, direction, newPaneId, newPtyId) =>
    set((state) => {
      const session = state.sessions[worktreePath];
      const tab = findTabByPtyId(session, ptyId);
      if (!session || !tab) return state;
      const newSessions = {
        ...state.sessions,
        [worktreePath]: replaceTabNode(
          session,
          tab.id,
          splitNode(tab.node, ptyId, direction, {
            branchId: crypto.randomUUID(),
            leafId: newPaneId,
            ptyId: newPtyId,
          }),
        ),
      };
      saveLayouts(newSessions);
      return {
        sessions: newSessions,
        focusedPaneIdByTab: setFocusedPaneForTab(state.focusedPaneIdByTab, tab.id, newPaneId),
        focusedPtyId: shouldSyncActiveFocus(state.activeWorktree, worktreePath)
          ? newPtyId
          : state.focusedPtyId,
      };
    }),

  addTab: (worktreePath, paneId, ptyId) =>
    set((state) => {
      const session = state.sessions[worktreePath];
      if (!session) return state;
      const tabId = crypto.randomUUID();
      const newSession: WorktreeTerminalSession = {
        tabs: [...session.tabs, { id: tabId, node: { id: paneId, type: "leaf", ptyId } }],
        activeTabId: tabId,
      };
      const newSessions = { ...state.sessions, [worktreePath]: newSession };
      saveLayouts(newSessions);
      return {
        sessions: newSessions,
        focusedPaneIdByTab: setFocusedPaneForTab(state.focusedPaneIdByTab, tabId, paneId),
        focusedPtyId: shouldSyncActiveFocus(state.activeWorktree, worktreePath)
          ? ptyId
          : state.focusedPtyId,
      };
    }),

  setActiveTab: (worktreePath, tabId) =>
    set((state) => {
      const session = state.sessions[worktreePath];
      if (!session || session.activeTabId === tabId) return state;
      const tab = session.tabs.find((entry) => entry.id === tabId);
      if (!tab) return state;

      const newSession: WorktreeTerminalSession = { ...session, activeTabId: tabId };
      const newSessions = { ...state.sessions, [worktreePath]: newSession };
      saveLayouts(newSessions);

      const focus = resolveTabFocus(tab, state.focusedPaneIdByTab[tabId]);
      const isActiveWorktree = state.activeWorktree === worktreePath;

      // Clear bell/attention only for panes that just became visible.
      const nextBellPtyIds = new Set(state.bellPtyIds);
      let nextAiSessions = state.aiSessions;
      if (isActiveWorktree) {
        for (const { ptyId } of collectTerminalPanes(tab.node)) {
          if (!ptyId) continue;
          nextBellPtyIds.delete(ptyId);
          nextAiSessions = clearAttentionForPty(nextAiSessions, ptyId);
        }
      }

      return {
        sessions: newSessions,
        focusedPaneIdByTab: setFocusedPaneForTab(state.focusedPaneIdByTab, tabId, focus.paneId),
        focusedPtyId: isActiveWorktree ? focus.ptyId : state.focusedPtyId,
        bellPtyIds: nextBellPtyIds,
        aiSessions: nextAiSessions,
      };
    }),

  closeTab: (worktreePath, tabId) =>
    set((state) => {
      const session = state.sessions[worktreePath];
      const tabIndex = session?.tabs.findIndex((tab) => tab.id === tabId) ?? -1;
      if (!session || tabIndex < 0) return state;

      const closedTab = session.tabs[tabIndex];
      const nextBellPtyIds = new Set(state.bellPtyIds);
      const nextAiSessions = { ...state.aiSessions };
      for (const { ptyId } of collectTerminalPanes(closedTab.node)) {
        if (ptyId) {
          nextBellPtyIds.delete(ptyId);
          delete nextAiSessions[ptyId];
        }
      }

      const remainingTabs = session.tabs.filter((tab) => tab.id !== tabId);
      const newSessions = { ...state.sessions };
      let focus: TabFocus = { paneId: null, ptyId: null };
      let focusedPaneIdByTab = dropTabFocusEntries(state.focusedPaneIdByTab, [tabId]);

      if (remainingTabs.length > 0) {
        const nextActiveTab =
          session.activeTabId === tabId
            ? (remainingTabs[Math.min(tabIndex, remainingTabs.length - 1)] ?? remainingTabs[0])
            : (remainingTabs.find((tab) => tab.id === session.activeTabId) ?? remainingTabs[0]);
        newSessions[worktreePath] = { tabs: remainingTabs, activeTabId: nextActiveTab.id };
        focus = resolveTabFocus(nextActiveTab, focusedPaneIdByTab[nextActiveTab.id]);
        focusedPaneIdByTab = setFocusedPaneForTab(
          focusedPaneIdByTab,
          nextActiveTab.id,
          focus.paneId,
        );
      } else {
        delete newSessions[worktreePath];
        delete layoutCache[worktreePath];
      }
      saveLayouts(newSessions);

      return {
        sessions: newSessions,
        focusedPaneIdByTab,
        focusedPtyId: state.activeWorktree === worktreePath ? focus.ptyId : state.focusedPtyId,
        bellPtyIds: nextBellPtyIds,
        aiSessions: nextAiSessions,
      };
    }),

  removeSession: (worktreePath, nextActiveWorktree = null) =>
    set((state) => {
      const newSessions = { ...state.sessions };
      const nextBellPtyIds = new Set(state.bellPtyIds);
      let nextAiSessions = { ...state.aiSessions };
      const existingSession = state.sessions[worktreePath];
      let focusedPaneIdByTab = state.focusedPaneIdByTab;
      if (existingSession) {
        for (const { ptyId } of collectSessionPanes(existingSession)) {
          if (ptyId) {
            nextBellPtyIds.delete(ptyId);
            delete nextAiSessions[ptyId];
          }
        }
        focusedPaneIdByTab = dropTabFocusEntries(
          focusedPaneIdByTab,
          existingSession.tabs.map((tab) => tab.id),
        );
      }
      delete newSessions[worktreePath];
      delete layoutCache[worktreePath];
      saveLayouts(newSessions);

      const shouldSwitchActiveWorktree = state.activeWorktree === worktreePath;
      const resolvedActiveWorktree = shouldSwitchActiveWorktree
        ? nextActiveWorktree
        : state.activeWorktree;
      const activeSession = resolvedActiveWorktree
        ? newSessions[resolvedActiveWorktree]
        : undefined;
      const nextActiveFocus = resolveSessionFocus(activeSession, focusedPaneIdByTab);

      const nextActiveTab = findActiveTab(activeSession);
      if (nextActiveTab) {
        focusedPaneIdByTab = setFocusedPaneForTab(
          focusedPaneIdByTab,
          nextActiveTab.id,
          nextActiveFocus.paneId,
        );
      }

      if (nextActiveTab) {
        for (const { ptyId } of collectTerminalPanes(nextActiveTab.node)) {
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
        focusedPaneIdByTab,
        focusedPtyId: shouldSwitchActiveWorktree ? nextActiveFocus.ptyId : state.focusedPtyId,
        activeWorktree: resolvedActiveWorktree,
      };
    }),

  closeTerminal: (worktreePath, ptyId) =>
    set((state) => {
      const session = state.sessions[worktreePath];
      const tab = findTabByPtyId(session, ptyId);
      if (!session || !tab) return state;

      const updatedNode = removeNode(tab.node, ptyId);
      const nextBellPtyIds = new Set(state.bellPtyIds);
      nextBellPtyIds.delete(ptyId);
      const nextAiSessions = { ...state.aiSessions };
      delete nextAiSessions[ptyId];

      const newSessions = { ...state.sessions };
      let focusedPaneIdByTab = state.focusedPaneIdByTab;
      let focus: TabFocus = { paneId: null, ptyId: null };

      if (updatedNode) {
        newSessions[worktreePath] = replaceTabNode(session, tab.id, updatedNode);
        focus = resolveTabFocus({ ...tab, node: updatedNode }, state.focusedPaneIdByTab[tab.id]);
        focusedPaneIdByTab = setFocusedPaneForTab(focusedPaneIdByTab, tab.id, focus.paneId);
      } else {
        // Last pane of the tab — drop the tab entirely.
        const remainingTabs = session.tabs.filter((entry) => entry.id !== tab.id);
        focusedPaneIdByTab = dropTabFocusEntries(focusedPaneIdByTab, [tab.id]);
        if (remainingTabs.length > 0) {
          const tabIndex = session.tabs.findIndex((entry) => entry.id === tab.id);
          const nextActiveTab =
            session.activeTabId === tab.id
              ? (remainingTabs[Math.min(tabIndex, remainingTabs.length - 1)] ?? remainingTabs[0])
              : (remainingTabs.find((entry) => entry.id === session.activeTabId) ??
                remainingTabs[0]);
          newSessions[worktreePath] = { tabs: remainingTabs, activeTabId: nextActiveTab.id };
          focus = resolveTabFocus(nextActiveTab, focusedPaneIdByTab[nextActiveTab.id]);
          focusedPaneIdByTab = setFocusedPaneForTab(
            focusedPaneIdByTab,
            nextActiveTab.id,
            focus.paneId,
          );
        } else {
          delete newSessions[worktreePath];
          delete layoutCache[worktreePath];
        }
      }
      saveLayouts(newSessions);

      return {
        sessions: newSessions,
        focusedPaneIdByTab,
        focusedPtyId: state.activeWorktree === worktreePath ? focus.ptyId : state.focusedPtyId,
        bellPtyIds: nextBellPtyIds,
        aiSessions: nextAiSessions,
      };
    }),

  setActiveWorktree: (worktreePath) =>
    set((state) => {
      const session = worktreePath ? state.sessions[worktreePath] : undefined;
      const nextFocus = resolveSessionFocus(session, state.focusedPaneIdByTab);
      let nextFocusedPaneIdByTab = state.focusedPaneIdByTab;
      const activeTab = findActiveTab(session);
      if (activeTab) {
        nextFocusedPaneIdByTab = setFocusedPaneForTab(
          state.focusedPaneIdByTab,
          activeTab.id,
          nextFocus.paneId,
        );
      }
      const nextBellPtyIds = new Set(state.bellPtyIds);
      let nextAiSessions = state.aiSessions;
      // Only the visible tab's panes are actually seen — background tabs keep
      // their bell/attention markers for the tab-bar indicators.
      if (activeTab) {
        for (const { ptyId } of collectTerminalPanes(activeTab.node)) {
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
        focusedPaneIdByTab: nextFocusedPaneIdByTab,
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
      let tab = findTabByPtyId(activeSession, ptyId);
      if (!tab) {
        for (const session of Object.values(state.sessions)) {
          tab = findTabByPtyId(session, ptyId);
          if (tab) break;
        }
      }

      if (!tab) {
        if (state.focusedPtyId === ptyId && nextAiSessions === state.aiSessions) {
          return state;
        }
        return { focusedPtyId: ptyId, aiSessions: nextAiSessions };
      }

      const pane = findTerminalPaneByPtyId(tab.node, ptyId);
      return {
        focusedPtyId: ptyId,
        aiSessions: nextAiSessions,
        focusedPaneIdByTab: pane
          ? setFocusedPaneForTab(state.focusedPaneIdByTab, tab.id, pane.paneId)
          : state.focusedPaneIdByTab,
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
        if (status === "attention" && visibleTabContainsPty(state, ptyId)) {
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

  updateSizes: (worktreePath, tabId, nodePath, ratios) =>
    set((state) => {
      const session = state.sessions[worktreePath];
      const tab = session?.tabs.find((entry) => entry.id === tabId);
      if (!session || !tab) return state;
      const updated = setSizesAtPath(tab.node, nodePath, ratios);
      const newSessions = {
        ...state.sessions,
        [worktreePath]: replaceTabNode(session, tabId, updated),
      };
      saveLayouts(newSessions);
      return { sessions: newSessions };
    }),

  setPaneLabel: (worktreePath, paneId, label) =>
    set((state) => {
      const session = state.sessions[worktreePath];
      const tab = findTabByPaneId(session, paneId);
      if (!session || !tab) return state;
      const updated = setLeafLabel(tab.node, paneId, label);
      if (updated === tab.node) return state;
      const newSessions = {
        ...state.sessions,
        [worktreePath]: replaceTabNode(session, tab.id, updated),
      };
      saveLayouts(newSessions);
      return { sessions: newSessions };
    }),

  setDetectedTheme: (theme) => set({ detectedTheme: theme }),
  loadTheme: (theme) => set({ theme }),

  initLayouts: async () => {
    try {
      const raw = await loadTerminalLayouts();
      const parsed = JSON.parse(raw) as Record<string, PersistedWorktreeSession | SplitNode>;
      layoutCache = {};
      for (const [worktreePath, value] of Object.entries(parsed)) {
        const session = normalizeSavedSession(value, () => crypto.randomUUID());
        if (session) {
          layoutCache[worktreePath] = session;
        }
      }
    } catch {
      layoutCache = {};
    }
  },
}));

export { countLeaves, assignPtyIds } from "../lib/split-tree";
