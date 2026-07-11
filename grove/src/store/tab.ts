import { create } from "zustand";
import type { AppTab, AppTabType } from "../types";
import { useBrowserStore } from "./browser";
import { useFileViewerStore } from "./file-viewer";

export interface TabSession {
  tabs: AppTab[];
  activeTabId: string;
}

interface TabState {
  sessions: Record<string, TabSession>;
  activeWorktree: string | null;
  setActiveWorktree: (worktreePath: string | null) => void;
  addTab: (type: AppTabType, title: string) => string;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  updateTabTitle: (tabId: string, title: string) => void;
  removeSession: (worktreePath: string) => void;
}

/**
 * Terminal content is not an AppTab entry: terminal tabs live in the terminal
 * store and the bar renders them directly. "terminal" stays valid as an
 * activeTabId sentinel meaning "the terminal content is shown".
 */
const DEFAULT_SESSION: TabSession = {
  tabs: [],
  activeTabId: "terminal",
};

/** Rebuild a session from persisted closable tabs. */
export function createSessionWithClosableTabs(
  closableTabs: AppTab[],
  activeTabId: string,
): TabSession {
  return {
    tabs: closableTabs,
    activeTabId: closableTabs.some((tab) => tab.id === activeTabId) ? activeTabId : "terminal",
  };
}

function getSessionForWorktree(state: TabState, worktreePath: string | null): TabSession {
  if (!worktreePath) return DEFAULT_SESSION;
  return state.sessions[worktreePath] ?? DEFAULT_SESSION;
}

function getSession(state: TabState): TabSession {
  return getSessionForWorktree(state, state.activeWorktree);
}

function updateSession(
  state: TabState,
  updater: (session: TabSession) => TabSession,
): Partial<TabState> {
  const wt = state.activeWorktree;
  if (!wt) return {};
  const current = state.sessions[wt] ?? DEFAULT_SESSION;
  const updated = updater(current);
  if (updated === current) return {};
  return { sessions: { ...state.sessions, [wt]: updated } };
}

export const useTabStore = create<TabState>((set, get) => ({
  sessions: {},
  activeWorktree: null,

  setActiveWorktree: (worktreePath) => {
    const state = get();
    if (state.activeWorktree === worktreePath) return;
    // Single atomic set — ensure session exists with a fresh copy
    const sessions =
      worktreePath && !state.sessions[worktreePath]
        ? {
            ...state.sessions,
            [worktreePath]: {
              tabs: [...DEFAULT_SESSION.tabs],
              activeTabId: DEFAULT_SESSION.activeTabId,
            },
          }
        : state.sessions;
    set({ activeWorktree: worktreePath, sessions });
  },

  addTab: (type, title) => {
    const state = get();
    const session = getSession(state);

    // Changes is a per-worktree singleton — re-activate an existing tab
    if (type === "changes" && session.tabs.some((t) => t.id === "changes")) {
      set(updateSession(state, () => ({ ...session, activeTabId: "changes" })));
      return "changes";
    }

    const id = type === "changes" ? "changes" : crypto.randomUUID();
    const tab: AppTab = { id, type, title, closable: true };
    set(
      updateSession(state, () => ({
        tabs: [...session.tabs, tab],
        activeTabId: id,
      })),
    );
    return id;
  },

  closeTab: (tabId) => {
    const state = get();
    const session = getSession(state);
    const tab = session.tabs.find((t) => t.id === tabId);
    if (!tab || !tab.closable) return;
    const tabIndex = session.tabs.findIndex((t) => t.id === tabId);
    const newTabs = session.tabs.filter((t) => t.id !== tabId);
    const wasActive = session.activeTabId === tabId;
    // Prefer the closable neighbor that slid into the closed slot (or the last
    // closable before it); when none remain, land on Terminal — never on a
    // pinned tab the user didn't pick.
    const newActiveTabId = (() => {
      if (!wasActive) return session.activeTabId;
      const slotTab = newTabs[Math.min(tabIndex, newTabs.length - 1)];
      if (slotTab?.closable) return slotTab.id;
      const closable = newTabs.filter((t) => t.closable);
      return closable.length > 0 ? closable[closable.length - 1].id : "terminal";
    })();
    set(
      updateSession(state, () => ({
        tabs: newTabs,
        activeTabId: newActiveTabId,
      })),
    );
    if (tab.type === "browser") {
      useBrowserStore.getState().removeTab(tabId);
    } else if (tab.type === "file") {
      useFileViewerStore.getState().removeTab(tabId);
    }
  },

  setActiveTab: (tabId) =>
    set((state) => {
      const session = getSession(state);
      // "terminal" has no tab entry — it addresses the terminal content.
      if (tabId !== "terminal" && !session.tabs.some((t) => t.id === tabId)) return {};
      return updateSession(state, () => ({
        ...session,
        activeTabId: tabId,
      }));
    }),

  updateTabTitle: (tabId, title) =>
    set((state) => {
      const session = getSession(state);
      const tab = session.tabs.find((t) => t.id === tabId);
      if (!tab || !tab.closable || tab.title === title) return {};
      return updateSession(state, () => ({
        ...session,
        tabs: session.tabs.map((t) => (t.id === tabId ? { ...t, title } : t)),
      }));
    }),

  removeSession: (worktreePath) => {
    const state = get();
    const session = state.sessions[worktreePath];
    if (!session) return;
    const newSessions = { ...state.sessions };
    delete newSessions[worktreePath];
    set({ sessions: newSessions });
    const browserStore = useBrowserStore.getState();
    const fileViewerStore = useFileViewerStore.getState();
    for (const tab of session.tabs) {
      if (tab.type === "browser") {
        browserStore.removeTab(tab.id);
      } else if (tab.type === "file") {
        fileViewerStore.removeTab(tab.id);
      }
    }
  },
}));

// Derived selectors for consumers
export function selectCurrentTabs(state: TabState): AppTab[] {
  return getSession(state).tabs;
}

export function selectCurrentActiveTabId(state: TabState): string {
  return getSession(state).activeTabId;
}

export function selectTabsForWorktree(state: TabState, worktreePath: string | null): AppTab[] {
  return getSessionForWorktree(state, worktreePath).tabs;
}

export function selectActiveTabIdForWorktree(state: TabState, worktreePath: string | null): string {
  return getSessionForWorktree(state, worktreePath).activeTabId;
}
