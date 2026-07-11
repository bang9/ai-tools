import { create } from "zustand";
import type { BrowserNavEvent } from "../lib/platform";
import {
  loadHistory,
  recordFavicon,
  saveHistory,
  upsertHistory,
  normalizeHistoryUrl,
  type BrowserHistoryEntry,
} from "../lib/browser-history";

/**
 * Per-tab last-recorded normalized URL, used to decide whether a settled nav
 * event is a NEW visit (bump visitCount) or a follow-up title/favicon update of
 * a page already counted. Non-reactive: pure dedup memory, not UI state.
 */
const lastRecordedByTab = new Map<string, string>();

export interface BrowserNavState {
  /** URL currently shown by the native webview. */
  url: string;
  /** Page title reported by the native webview, if known. */
  title: string | null;
  /** Whether the native webview is currently loading. */
  loading: boolean;
  /** Whether the native webview can navigate back. */
  canGoBack: boolean;
  /** Whether the native webview can navigate forward. */
  canGoForward: boolean;
  /** Stack of committed URLs for back/forward heuristics. */
  history: string[];
  /** Position in `history`. */
  index: number;
}

interface BrowserState {
  navs: Record<string, BrowserNavState>;
  /**
   * Frecency-ranked visited-page history (every committed navigation, not just
   * address-bar entries), capped and persisted to localStorage.
   */
  history: BrowserHistoryEntry[];
  /** Committed navigation from the URL bar. */
  navigate: (tabId: string, url: string) => void;
  /** Apply a navigation event emitted by the native webview. */
  applyNavEvent: (ev: BrowserNavEvent) => void;
  /**
   * Collapse a tab's logical state after its native webview was evicted. The
   * entry survives with url + title intact, but the history stack collapses to
   * just the current URL: the native session history is gone, so the honest
   * model is "a fresh tab restored at the same URL" — the FE stack must not
   * claim back/forward that native can no longer perform.
   */
  suspendTab: (tabId: string) => void;
  removeTab: (tabId: string) => void;
  /** Attach a favicon to the history entry for `url` (no visit-count change). */
  recordFavicon: (url: string, faviconUrl: string) => void;
}

export const useBrowserStore = create<BrowserState>((set) => ({
  navs: {},
  history: loadHistory(),

  navigate: (tabId, url) =>
    set((state) => {
      const nav = state.navs[tabId];
      if (nav?.url === url) return {};
      const history = nav ? [...nav.history.slice(0, nav.index + 1), url] : [url];
      const index = history.length - 1;
      return {
        navs: {
          ...state.navs,
          [tabId]: {
            url,
            title: nav?.title ?? null,
            loading: true,
            canGoBack: index > 0,
            canGoForward: false,
            history,
            index,
          },
        },
      };
    }),

  applyNavEvent: (ev) =>
    set((state) => {
      const nav = state.navs[ev.tabId];
      // Never create entries from native events — only update known tabs.
      if (!nav) return {};

      let history = nav.history;
      let index = nav.index;

      if (ev.url === history[index]) {
        // In-place update (loading/title change, or same-URL reload).
      } else if (ev.url === history[index - 1]) {
        index = index - 1;
      } else if (ev.url === history[index + 1]) {
        index = index + 1;
      } else if (!ev.loading) {
        // URL changed by the time the load settled: a server redirect or
        // canonicalization of the CURRENT entry (e.g. http://naver.com/ →
        // https://www.naver.com/). Replace instead of pushing, or redirects
        // create phantom entries and Back "navigates" to the pre-redirect URL
        // of the same page. New entries are only pushed by load-start events.
        history = [...history];
        history[index] = ev.url;
      } else {
        history = [...history.slice(0, index + 1), ev.url];
        index = history.length - 1;
      }

      // Record the visit into the persistent frecency history once the page
      // has settled (loading=false). A settled URL identical to the tab's last
      // recorded one is a follow-up (title/favicon) update, not a new visit —
      // refresh it without bumping the visit count.
      let visited = state.history;
      if (!ev.loading) {
        const normalized = normalizeHistoryUrl(ev.url);
        if (normalized && normalized !== "about:blank") {
          const isNewVisit = lastRecordedByTab.get(ev.tabId) !== normalized;
          lastRecordedByTab.set(ev.tabId, normalized);
          visited = upsertHistory(
            state.history,
            ev.url,
            ev.title ?? nav.title ?? "",
            Date.now(),
            isNewVisit,
          );
          if (visited !== state.history) saveHistory(visited);
        }
      }

      return {
        history: visited,
        navs: {
          ...state.navs,
          [ev.tabId]: {
            url: ev.url,
            title: ev.title ?? nav.title,
            loading: ev.loading,
            canGoBack: ev.canGoBack ?? index > 0,
            canGoForward: ev.canGoForward ?? index < history.length - 1,
            history,
            index,
          },
        },
      };
    }),

  suspendTab: (tabId) =>
    set((state) => {
      const nav = state.navs[tabId];
      if (!nav) return {};
      // A fresh restored tab is a new visit again.
      lastRecordedByTab.delete(tabId);
      return {
        navs: {
          ...state.navs,
          [tabId]: {
            ...nav,
            loading: false,
            canGoBack: false,
            canGoForward: false,
            history: [nav.url],
            index: 0,
          },
        },
      };
    }),

  removeTab: (tabId) =>
    set((state) => {
      lastRecordedByTab.delete(tabId);
      if (!state.navs[tabId]) return {};
      const navs = { ...state.navs };
      delete navs[tabId];
      return { navs };
    }),

  recordFavicon: (url, faviconUrl) =>
    set((state) => {
      const history = recordFavicon(state.history, url, faviconUrl);
      if (history === state.history) return {};
      saveHistory(history);
      return { history };
    }),
}));

export function selectNav(tabId: string) {
  return (state: BrowserState): BrowserNavState | null => state.navs[tabId] ?? null;
}
