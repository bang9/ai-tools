import { useBrowserStore } from "../store/browser";
import { useTabStore } from "../store/tab";
import { browserTabTitle } from "./browser-url";
import { selectEvictions, type WebviewVisibility } from "./browser-eviction";
import { registerSyncJob } from "./sync-manager";
import {
  browserClose,
  browserCloseAll,
  browserCreate,
  browserGoBack,
  browserGoForward,
  browserHasNativeHistory,
  browserNavigate,
  browserOpenDevtools,
  browserReload,
  browserSetBounds,
  browserSetVisible,
  onBrowserNav,
  onBrowserNewWindow,
} from "./platform";
import type { BrowserBounds } from "./platform";

/**
 * Singleton side-effect layer bridging the pure browser store to the native
 * webview commands. Keeping this out of the store lets the store stay free of
 * platform imports (its tests run in a node env).
 */

/**
 * Tabs that have a live native webview. Backed by globalThis so the set
 * survives HMR module re-evaluation (the native webviews it tracks do).
 */
const CREATED_KEY = "__groveBrowserWebviewCreated__";
const created: Set<string> = (() => {
  const scope = globalThis as Record<string, unknown>;
  const existing = scope[CREATED_KEY];
  if (existing instanceof Set) return existing as Set<string>;
  const next = new Set<string>();
  scope[CREATED_KEY] = next;
  return next;
})();

/**
 * Per-webview visibility bookkeeping, keyed by tabId. Feeds the pure eviction
 * policy. globalThis-backed so it survives HMR alongside `created` (the native
 * webviews it describes do). Every mutation flows through the lifecycle
 * functions below — components must never write this directly.
 */
const VISIBILITY_KEY = "__groveBrowserWebviewVisibility__";
const visibility: Map<string, WebviewVisibility> = (() => {
  const scope = globalThis as Record<string, unknown>;
  const existing = scope[VISIBILITY_KEY];
  if (existing instanceof Map) return existing as Map<string, WebviewVisibility>;
  const next = new Map<string, WebviewVisibility>();
  scope[VISIBILITY_KEY] = next;
  return next;
})();

const EVICTION_JOB_KEY = "browser-eviction";
/** How often the idle-eviction sweep runs (TTL is minutes-scale). */
const EVICTION_SWEEP_INTERVAL_MS = 30 * 1000;

function warn(err: unknown): void {
  console.warn("[browser-webview]", err);
}

export function isBrowserWebviewCreated(tabId: string): boolean {
  return created.has(tabId);
}

export function createBrowserWebview(tabId: string, url: string, bounds: BrowserBounds): void {
  created.add(tabId);
  // Created over the active host, so it starts visible. The visibility effect
  // in BrowserPanel calls setBrowserVisible right after and corrects this if
  // the tab is actually covered/inactive.
  visibility.set(tabId, { visible: true, hiddenSince: null });
  browserCreate(tabId, url, bounds).catch(warn);
}

export function navigateBrowser(tabId: string, url: string): void {
  if (!created.has(tabId)) return;
  browserNavigate(tabId, url).catch(warn);
}

/**
 * Navigate to an adjacent entry in the frontend URL stack. Used on platforms
 * without a native session-history API (Tauri): JS `history.back()` is not an
 * option there — WKWebView swaps WebContent processes on cross-origin
 * navigations and silently drops JS history traversal across that boundary.
 * An explicit load has no such restriction. The store's index is updated by
 * the resulting nav event (applyNavEvent matches history[index∓1]).
 */
function navigateStack(tabId: string, offset: -1 | 1): void {
  const nav = useBrowserStore.getState().navs[tabId];
  if (!nav) return;
  const target = nav.history[nav.index + offset];
  if (!target) return;
  browserNavigate(tabId, target).catch(warn);
}

export function browserBack(tabId: string): void {
  if (!created.has(tabId)) return;
  if (browserHasNativeHistory) {
    browserGoBack(tabId).catch(warn);
  } else {
    navigateStack(tabId, -1);
  }
}

export function browserForward(tabId: string): void {
  if (!created.has(tabId)) return;
  if (browserHasNativeHistory) {
    browserGoForward(tabId).catch(warn);
  } else {
    navigateStack(tabId, 1);
  }
}

export function browserReloadTab(tabId: string): void {
  if (!created.has(tabId)) return;
  browserReload(tabId).catch(warn);
}

export function browserOpenDevtoolsTab(tabId: string): void {
  if (!created.has(tabId)) return;
  browserOpenDevtools(tabId).catch(warn);
}

export function syncBrowserBounds(tabId: string, bounds: BrowserBounds): void {
  if (!created.has(tabId)) return;
  browserSetBounds(tabId, bounds).catch(warn);
}

export function setBrowserVisible(tabId: string, visible: boolean): void {
  if (!created.has(tabId)) return;
  // Single choke point for visibility bookkeeping. Preserve `hiddenSince` on
  // repeated hidden signals so the TTL measures *continuous* hidden duration
  // (a transient hide followed by another hide must not reset the clock).
  const record = visibility.get(tabId);
  if (visible) {
    visibility.set(tabId, { visible: true, hiddenSince: null });
  } else if (!record || record.visible) {
    visibility.set(tabId, { visible: false, hiddenSince: Date.now() });
  }
  browserSetVisible(tabId, visible).catch(warn);
}

/** Forget all bookkeeping for a webview that is no longer alive. */
function forget(tabId: string): void {
  created.delete(tabId);
  visibility.delete(tabId);
}

/**
 * Evict a single webview: destroy the native view and collapse the tab's
 * logical state so the store no longer claims history the native session can
 * no longer perform.
 */
function evict(tabId: string): void {
  browserClose(tabId).catch(warn);
  forget(tabId);
  useBrowserStore.getState().suspendTab(tabId);
}

/**
 * Run the idle-eviction policy over currently-alive webviews and evict the
 * ones it selects. Exported for tests / on-demand sweeps; normally driven by
 * the sync-manager job registered in initBrowserWebviewBridge.
 */
export function sweepBrowserEvictions(now: number = Date.now()): void {
  const records: Record<string, WebviewVisibility> = {};
  for (const tabId of created) {
    records[tabId] = visibility.get(tabId) ?? {
      visible: false,
      hiddenSince: now,
    };
  }
  for (const tabId of selectEvictions(records, now)) {
    evict(tabId);
  }
}

let evictionSweepRegistered = false;
function ensureEvictionSweep(): void {
  // Idempotent for normal re-mounts; re-registers after HMR (module reset)
  // which is harmless — registerSyncJob overwrites by key.
  if (evictionSweepRegistered) return;
  evictionSweepRegistered = true;
  registerSyncJob(
    EVICTION_JOB_KEY,
    async () => {
      sweepBrowserEvictions();
    },
    EVICTION_SWEEP_INTERVAL_MS,
  );
}

let bridgeInitialized = false;
const GLOBAL_FLAG = "__groveBrowserWebviewBridge__";

/**
 * Wire native nav events into the store + tab titles, and close native
 * webviews when their nav entry is removed. Idempotent across re-imports and
 * HMR reloads (guarded by a module flag AND a globalThis key).
 */
export function initBrowserWebviewBridge(): void {
  // Register the sweep before the idempotency guards so an HMR reload that
  // reset this module's state re-arms it.
  ensureEvictionSweep();
  if (bridgeInitialized) return;
  const globalScope = globalThis as Record<string, unknown>;
  if (globalScope[GLOBAL_FLAG]) {
    bridgeInitialized = true;
    return;
  }
  globalScope[GLOBAL_FLAG] = true;
  bridgeInitialized = true;

  // Deferred so a synchronous bridge-unavailable throw becomes a rejection.
  void (async () => {
    try {
      // A fresh renderer session may have inherited orphan webviews from a
      // previous one (tab sessions are in-memory, native webviews are not).
      if (created.size === 0) {
        await browserCloseAll();
      }
      await onBrowserNav((ev) => {
        useBrowserStore.getState().applyNavEvent(ev);
        useTabStore.getState().updateTabTitle(ev.tabId, ev.title ?? browserTabTitle(ev.url));
      });
    } catch (err) {
      warn(err);
    }
  })();

  // target="_blank" links / window.open: open a new Grove browser tab
  // instead of a native window. The active BrowserPanel's visibility effect
  // creates the native webview once the tab + nav entry exist.
  void (async () => {
    try {
      await onBrowserNewWindow((ev) => {
        const title = browserTabTitle(ev.url);
        const newTabId = useTabStore.getState().addTab("browser", title);
        useBrowserStore.getState().navigate(newTabId, ev.url);
      });
    } catch (err) {
      warn(err);
    }
  })();

  // Close native webviews for tabs whose nav entry was removed.
  useBrowserStore.subscribe((state, prevState) => {
    if (state.navs === prevState.navs) return;
    for (const tabId of Object.keys(prevState.navs)) {
      if (!state.navs[tabId] && created.has(tabId)) {
        browserClose(tabId).catch(warn);
        forget(tabId);
      }
    }
  });
}
