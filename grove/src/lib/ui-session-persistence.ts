import type { AppTab } from "../types";
import { createSessionWithClosableTabs, useTabStore, type TabSession } from "../store/tab";
import { useBrowserStore, type BrowserNavState } from "../store/browser";
import { useFileViewerStore, type FileViewerTabState } from "../store/file-viewer";
import { useRightPanelStore, type RightPanelMode } from "../store/right-panel";
import { loadJsonState, saveJsonState } from "./ui-state-storage";

const TAB_SESSIONS_KEY = "grove.tabSessions.v1";
const BROWSER_NAVS_KEY = "grove.browserNavs.v1";
const FILE_VIEWER_TABS_KEY = "grove.fileViewerTabs.v1";
const RIGHT_PANEL_MODE_KEY = "grove.rightPanelMode.v1";

interface PersistedTab {
  id: string;
  type: "browser" | "file" | "changes";
  title: string;
}

interface PersistedSession {
  tabs: PersistedTab[];
  activeTabId: string;
}

interface PersistedBrowserNav {
  url: string;
  title: string | null;
}

interface PersistedFileViewerTab {
  rootPath: string;
  path: string;
  name: string;
}

function isPersistedTab(value: unknown): value is PersistedTab {
  if (!value || typeof value !== "object") return false;
  const tab = value as Record<string, unknown>;
  return (
    typeof tab.id === "string" &&
    (tab.type === "browser" || tab.type === "file" || tab.type === "changes") &&
    typeof tab.title === "string"
  );
}

function rehydrateSessions(): {
  sessions: Record<string, TabSession>;
  tabIdsByType: { browser: Set<string>; file: Set<string> };
} {
  const sessions: Record<string, TabSession> = {};
  const tabIdsByType = { browser: new Set<string>(), file: new Set<string>() };
  const raw = loadJsonState<Record<string, PersistedSession>>(TAB_SESSIONS_KEY);
  if (!raw || typeof raw !== "object") return { sessions, tabIdsByType };

  for (const [worktreePath, persisted] of Object.entries(raw)) {
    if (!persisted || !Array.isArray(persisted.tabs)) continue;
    // Persisted order is the display order — keep it as-is.
    const closable: AppTab[] = persisted.tabs
      .filter(isPersistedTab)
      .map((tab) => ({ id: tab.id, type: tab.type, title: tab.title, closable: true }));
    if (closable.length === 0) continue;
    for (const tab of closable) {
      if (tab.type === "browser" || tab.type === "file") {
        tabIdsByType[tab.type].add(tab.id);
      }
    }
    sessions[worktreePath] = createSessionWithClosableTabs(
      closable,
      typeof persisted.activeTabId === "string" ? persisted.activeTabId : "terminal",
    );
  }
  return { sessions, tabIdsByType };
}

function rehydrateFileViewerTabs(validIds: Set<string>): Record<string, FileViewerTabState> {
  const result: Record<string, FileViewerTabState> = {};
  const raw = loadJsonState<Record<string, PersistedFileViewerTab>>(FILE_VIEWER_TABS_KEY);
  if (!raw || typeof raw !== "object") return result;

  for (const [tabId, entry] of Object.entries(raw)) {
    if (!validIds.has(tabId) || !entry) continue;
    if (
      typeof entry.rootPath !== "string" ||
      typeof entry.path !== "string" ||
      typeof entry.name !== "string"
    ) {
      continue;
    }
    // Contents load lazily when the tab first becomes active.
    result[tabId] = {
      rootPath: entry.rootPath,
      path: entry.path,
      name: entry.name,
      status: "idle",
      data: null,
      error: null,
    };
  }
  return result;
}

function rehydrateBrowserNavs(validIds: Set<string>): Record<string, BrowserNavState> {
  const result: Record<string, BrowserNavState> = {};
  const raw = loadJsonState<Record<string, PersistedBrowserNav>>(BROWSER_NAVS_KEY);
  if (!raw || typeof raw !== "object") return result;

  for (const [tabId, entry] of Object.entries(raw)) {
    if (!validIds.has(tabId) || !entry || typeof entry.url !== "string") continue;
    // Native session history is gone after a restart, so restore in the
    // suspended shape: a fresh tab at the same URL (see browser store's
    // suspendTab semantics).
    result[tabId] = {
      url: entry.url,
      title: typeof entry.title === "string" ? entry.title : null,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      history: [entry.url],
      index: 0,
    };
  }
  return result;
}

function persistedSessionsSnapshot(sessions: Record<string, TabSession>) {
  const snapshot: Record<string, PersistedSession> = {};
  for (const [worktreePath, session] of Object.entries(sessions)) {
    // Full closable tab list in display order (browser, file, changes).
    const closable = session.tabs
      .filter(
        (tab) =>
          tab.closable && (tab.type === "browser" || tab.type === "file" || tab.type === "changes"),
      )
      .map((tab) => ({
        id: tab.id,
        type: tab.type as PersistedTab["type"],
        title: tab.title,
      }));
    if (closable.length === 0) continue;
    snapshot[worktreePath] = { tabs: closable, activeTabId: session.activeTabId };
  }
  return snapshot;
}

function makeDedupedSaver<T>(key: string, snapshot: () => T): () => void {
  let lastSaved: string | null = null;
  return () => {
    const serialized = JSON.stringify(snapshot());
    if (serialized === lastSaved) return;
    lastSaved = serialized;
    saveJsonState(key, JSON.parse(serialized));
  };
}

/**
 * Restore persisted tab sessions (and their per-tab companion state) into the
 * stores, then keep localStorage in sync with future changes. Must run once at
 * startup, before the UI mounts.
 */
export function initUiSessionPersistence(): void {
  const { sessions, tabIdsByType } = rehydrateSessions();
  if (Object.keys(sessions).length > 0) {
    useTabStore.setState((state) => ({ sessions: { ...sessions, ...state.sessions } }));
    useFileViewerStore.setState((state) => ({
      filesByTab: { ...rehydrateFileViewerTabs(tabIdsByType.file), ...state.filesByTab },
    }));
    useBrowserStore.setState((state) => ({
      navs: { ...rehydrateBrowserNavs(tabIdsByType.browser), ...state.navs },
    }));
  }

  const persistedRightPanelMode = loadJsonState<RightPanelMode>(RIGHT_PANEL_MODE_KEY);
  if (persistedRightPanelMode === "commits" || persistedRightPanelMode === "file-browser") {
    useRightPanelStore.setState({ mode: persistedRightPanelMode });
  }

  const saveSessions = makeDedupedSaver(TAB_SESSIONS_KEY, () =>
    persistedSessionsSnapshot(useTabStore.getState().sessions),
  );
  const saveFileViewerTabs = makeDedupedSaver(FILE_VIEWER_TABS_KEY, () => {
    const snapshot: Record<string, PersistedFileViewerTab> = {};
    for (const [tabId, entry] of Object.entries(useFileViewerStore.getState().filesByTab)) {
      snapshot[tabId] = { rootPath: entry.rootPath, path: entry.path, name: entry.name };
    }
    return snapshot;
  });
  const saveBrowserNavs = makeDedupedSaver(BROWSER_NAVS_KEY, () => {
    const snapshot: Record<string, PersistedBrowserNav> = {};
    for (const [tabId, nav] of Object.entries(useBrowserStore.getState().navs)) {
      snapshot[tabId] = { url: nav.url, title: nav.title };
    }
    return snapshot;
  });

  const saveRightPanelMode = makeDedupedSaver(
    RIGHT_PANEL_MODE_KEY,
    () => useRightPanelStore.getState().mode,
  );

  saveSessions();
  saveFileViewerTabs();
  saveBrowserNavs();
  saveRightPanelMode();
  useTabStore.subscribe(saveSessions);
  useFileViewerStore.subscribe(saveFileViewerTabs);
  useBrowserStore.subscribe(saveBrowserNavs);
  useRightPanelStore.subscribe(saveRightPanelMode);
}
