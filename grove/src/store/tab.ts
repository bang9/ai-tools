import { create } from "zustand";
import type { AppTab, AppTabType } from "../types";
import { useBrowserStore } from "./browser";
import { useFileViewerStore } from "./file-viewer";
import { useTerminalStore } from "./terminal";

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
  moveTab: (tabId: string, targetIndex: number) => void;
  updateTabTitle: (tabId: string, title: string) => void;
  updateTabFavicon: (tabId: string, faviconUrl: string) => void;
  syncTerminalTabs: (worktreePath: string, terminalTabIds: string[] | null) => void;
  removeSession: (worktreePath: string) => void;
}

/**
 * Terminal tabs appear in the list as `type: "terminal"` entries whose ids are
 * the terminal store's tab ids — the tab store owns only their position; their
 * content lives in the terminal store and is reconciled via syncTerminalTabs.
 * TERMINAL_CONTENT_TAB_ID stays valid as an activeTabId sentinel meaning "the
 * terminal content is shown"; which terminal tab that is comes from the
 * terminal store.
 */
export const TERMINAL_CONTENT_TAB_ID = "terminal";
/** The Changes tab is a per-worktree singleton with a fixed id. */
export const CHANGES_TAB_ID = "changes";
/** Entry title meaning "no custom name" — chips derive "Terminal N" instead. */
export const DEFAULT_TERMINAL_TAB_TITLE = "Terminal";

const DEFAULT_SESSION: TabSession = {
  tabs: [],
  activeTabId: TERMINAL_CONTENT_TAB_ID,
};

function makeTerminalTabEntry(tabId: string): AppTab {
  return { id: tabId, type: "terminal", title: DEFAULT_TERMINAL_TAB_TITLE, closable: true };
}

/**
 * The tab that takes over when the entry at closedIndex leaves the list: the
 * neighbor that slid into its slot, or the last remaining tab. A terminal
 * entry is addressed via the sentinel plus the terminal tab to activate — its
 * uuid must never become activeTabId (nothing renders for it).
 */
export function resolveSuccessorTab(
  tabs: AppTab[],
  closedIndex: number,
): { activeTabId: string; terminalTabId?: string } {
  const slot = tabs[Math.min(closedIndex, tabs.length - 1)];
  if (!slot) return { activeTabId: TERMINAL_CONTENT_TAB_ID };
  if (slot.type === "terminal") {
    return { activeTabId: TERMINAL_CONTENT_TAB_ID, terminalTabId: slot.id };
  }
  return { activeTabId: slot.id };
}

/** Rebuild a session from persisted closable tabs. */
export function createSessionWithClosableTabs(
  closableTabs: AppTab[],
  activeTabId: string,
): TabSession {
  return {
    tabs: closableTabs,
    activeTabId: closableTabs.some((tab) => tab.id === activeTabId)
      ? activeTabId
      : TERMINAL_CONTENT_TAB_ID,
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
    if (type === "changes" && session.tabs.some((t) => t.id === CHANGES_TAB_ID)) {
      set(updateSession(state, () => ({ ...session, activeTabId: CHANGES_TAB_ID })));
      return CHANGES_TAB_ID;
    }

    const id = type === "changes" ? CHANGES_TAB_ID : crypto.randomUUID();
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
    if (!tab) return;
    // Terminal tabs close through closeTerminalTab (ptys must die with them);
    // their entries leave this list via syncTerminalTabs.
    if (tab.type === "terminal") return;
    const tabIndex = session.tabs.findIndex((t) => t.id === tabId);
    const newTabs = session.tabs.filter((t) => t.id !== tabId);
    const wasActive = session.activeTabId === tabId;
    const successor = wasActive ? resolveSuccessorTab(newTabs, tabIndex) : null;
    set(
      updateSession(state, () => ({
        tabs: newTabs,
        activeTabId: successor ? successor.activeTabId : session.activeTabId,
      })),
    );
    if (successor?.terminalTabId && state.activeWorktree) {
      useTerminalStore.getState().setActiveTab(state.activeWorktree, successor.terminalTabId);
    }
    if (tab.type === "browser") {
      useBrowserStore.getState().removeTab(tabId);
    } else if (tab.type === "file") {
      useFileViewerStore.getState().removeTab(tabId);
    }
  },

  setActiveTab: (tabId) =>
    set((state) => {
      const session = getSession(state);
      // The sentinel has no tab entry — it addresses the terminal content.
      if (tabId !== TERMINAL_CONTENT_TAB_ID && !session.tabs.some((t) => t.id === tabId)) {
        return {};
      }
      return updateSession(state, () => ({
        ...session,
        activeTabId: tabId,
      }));
    }),

  moveTab: (tabId, targetIndex) =>
    set((state) => {
      const session = getSession(state);
      const fromIndex = session.tabs.findIndex((t) => t.id === tabId);
      if (fromIndex < 0) return {};
      const clamped = Math.max(0, Math.min(targetIndex, session.tabs.length - 1));
      if (clamped === fromIndex) return {};
      const tabs = [...session.tabs];
      const [moved] = tabs.splice(fromIndex, 1);
      tabs.splice(clamped, 0, moved);
      return updateSession(state, () => ({ ...session, tabs }));
    }),

  syncTerminalTabs: (worktreePath, terminalTabIds) =>
    set((state) => {
      const session = state.sessions[worktreePath] ?? DEFAULT_SESSION;
      const desired = terminalTabIds ?? [];
      const desiredSet = new Set(desired);

      const kept = session.tabs.filter((tab) => tab.type !== "terminal" || desiredSet.has(tab.id));
      const existingIds = new Set(kept.filter((t) => t.type === "terminal").map((t) => t.id));
      const appended = desired.filter((id) => !existingIds.has(id)).map(makeTerminalTabEntry);
      const tabs = appended.length > 0 ? [...kept, ...appended] : kept;

      const unchanged =
        tabs.length === session.tabs.length && tabs.every((tab, i) => tab === session.tabs[i]);
      if (unchanged) return {};

      // The terminal went away entirely while its content was showing — move
      // to the first remaining tab so the user doesn't land on an empty pane.
      let activeTabId = session.activeTabId;
      if (terminalTabIds === null && activeTabId === TERMINAL_CONTENT_TAB_ID && tabs.length > 0) {
        activeTabId = tabs[0].id;
      }

      return {
        sessions: { ...state.sessions, [worktreePath]: { tabs, activeTabId } },
      };
    }),

  updateTabTitle: (tabId, title) =>
    set((state) => {
      const session = getSession(state);
      const tab = session.tabs.find((t) => t.id === tabId);
      if (!tab || tab.title === title) return {};
      return updateSession(state, () => ({
        ...session,
        tabs: session.tabs.map((t) => (t.id === tabId ? { ...t, title } : t)),
      }));
    }),

  updateTabFavicon: (tabId, faviconUrl) =>
    set((state) => {
      const session = getSession(state);
      const tab = session.tabs.find((t) => t.id === tabId);
      if (!tab || tab.faviconUrl === faviconUrl) return {};
      return updateSession(state, () => ({
        ...session,
        tabs: session.tabs.map((t) => (t.id === tabId ? { ...t, faviconUrl } : t)),
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
