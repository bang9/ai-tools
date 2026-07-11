import type {
  BrowserFaviconEvent,
  BrowserFindEvent,
  BrowserNavEvent,
  BrowserNewWindowEvent,
  UnlistenFn,
} from "./platform/types";

/**
 * Electron in-DOM `<webview>` browser manager (orca-style).
 *
 * Unlike Tauri (a native WKWebView composited *above* the DOM, made to overlay
 * via a transparent-window punchout), Electron renders each browser guest as an
 * in-DOM `<webview>` element. Because it lives in the document, DOM chrome — the
 * address dropdown, menus — overlays the page naturally through normal z-index
 * stacking; no punchout, no push-down.
 *
 * This module is the Electron implementation behind the `@platform` browser
 * command contract. It mirrors the exact command/event shapes the WebContentsView
 * path used (`browser:nav` payloads, etc.) so the shared orchestration in
 * `lib/browser-webview.ts` and `BrowserPanel` is platform-agnostic.
 *
 * ── Landmines ────────────────────────────────────────────────────────────────
 * • The `<webview>` element is created imperatively (NOT via JSX) and appended
 *   into the React-owned host div registered through `registerBrowserHostDom`.
 *   JSX `<webview>` would need TS intrinsic-element augmentation and re-mounts on
 *   every render; imperative creation keeps the guest alive across React renders.
 * • Grove keeps every browser tab mounted (`display:none` when inactive — see
 *   AppTabContent), so one `<webview>` per tab simply persists; we do NOT need
 *   orca's detach/reparent registry to survive tab switches.
 * • `browser_create` and host registration race (both fire in post-mount
 *   effects, order undefined). `reconcile()` creates the element only once BOTH
 *   the host and a desired URL exist, so either order works.
 * • Back/forward call `goBack()`/`goForward()` on the element directly; the
 *   resulting `did-navigate` updates the store URL. We must never turn that store
 *   URL change back into a `loadURL` or navigation loops. `browserNavigate` is
 *   the only path that calls `loadURL`, and it is only invoked for user commits.
 */

/** Shared persistent partition — parity with main.ts BROWSER_PARTITION so
 * imported cookies / logins apply to the in-DOM guests too. */
const BROWSER_PARTITION = "persist:grove-browser";

/** A DOM event dispatched by an Electron `<webview>` element. Only the fields
 * this module reads are typed; the element dispatches plain DOM events with
 * these extra properties attached. */
interface WebviewDomEvent extends Event {
  url?: string;
  title?: string;
  favicons?: string[];
  isMainFrame?: boolean;
  result?: { activeMatchOrdinal: number; matches: number; finalUpdate: boolean };
}

/** The subset of Electron's WebviewTag API this module drives. */
interface BrowserWebviewElement extends HTMLElement {
  src: string;
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  isLoading(): boolean;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  openDevTools(): void;
  findInPage(text: string, options?: { forward?: boolean; findNext?: boolean }): number;
  stopFindInPage(action: "clearSelection" | "keepSelection" | "activateSelection"): void;
}

interface GuestState {
  host: HTMLElement | null;
  webview: BrowserWebviewElement | null;
  /** Desired URL — the page to load once host+element exist. */
  url: string | null;
  visible: boolean;
  /**
   * True once the guest has fired `dom-ready`. LANDMINE: an Electron `<webview>`
   * element's methods (getURL, reload, goBack, canGoBack, findInPage, …) DO NOT
   * EXIST until `dom-ready` — calling them earlier throws "not a function".
   * Navigation via the `src` property is the only thing safe before ready.
   */
  ready: boolean;
}

type NavSub = (event: BrowserNavEvent) => void;
type NewWindowSub = (event: BrowserNewWindowEvent) => void;
type FaviconSub = (event: BrowserFaviconEvent) => void;
type FindSub = (event: BrowserFindEvent) => void;
type FindOpenSub = (event: { tabId: string }) => void;

interface DomWebviewRegistry {
  guests: Map<string, GuestState>;
  navSubs: Set<NavSub>;
  newWindowSubs: Set<NewWindowSub>;
  faviconSubs: Set<FaviconSub>;
  findSubs: Set<FindSub>;
  findOpenSubs: Set<FindOpenSub>;
}

// globalThis-backed so the registry (and the live guest elements it tracks)
// survive HMR module re-evaluation in dev.
const REGISTRY_KEY = "__groveBrowserDomWebviewRegistry__";
const registry: DomWebviewRegistry = (() => {
  const scope = globalThis as Record<string, unknown>;
  const existing = scope[REGISTRY_KEY] as DomWebviewRegistry | undefined;
  if (existing) return existing;
  const next: DomWebviewRegistry = {
    guests: new Map(),
    navSubs: new Set(),
    newWindowSubs: new Set(),
    faviconSubs: new Set(),
    findSubs: new Set(),
    findOpenSubs: new Set(),
  };
  scope[REGISTRY_KEY] = next;
  return next;
})();

function getState(tabId: string): GuestState {
  let state = registry.guests.get(tabId);
  if (!state) {
    state = { host: null, webview: null, url: null, visible: true, ready: false };
    registry.guests.set(tabId, state);
  }
  return state;
}

/** A webview whose guest is attached exposes its info/nav methods. */
function isReady(webview: BrowserWebviewElement): boolean {
  return typeof webview.getURL === "function";
}

function emitNav(tabId: string, webview: BrowserWebviewElement, loadingOverride?: boolean): void {
  // Guest methods do not exist before `dom-ready`; skip until they do (the
  // dom-ready handler emits the first reliable nav event).
  if (!isReady(webview)) return;
  const event: BrowserNavEvent = {
    tabId,
    url: webview.getURL(),
    title: webview.getTitle() || null,
    loading: loadingOverride ?? webview.isLoading(),
    canGoBack: webview.canGoBack(),
    canGoForward: webview.canGoForward(),
  };
  for (const sub of registry.navSubs) sub(event);
}

function isAllowedBrowserUrl(url: string): boolean {
  if (url === "about:blank") return true;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "file:"
    );
  } catch {
    return false;
  }
}

function wireWebviewEvents(tabId: string, webview: BrowserWebviewElement): void {
  const onNav = () => emitNav(tabId, webview);
  // `dom-ready` is the first point the guest's methods exist — mark ready and
  // emit the first reliable nav snapshot (URL/title/history).
  webview.addEventListener("dom-ready", () => {
    const state = registry.guests.get(tabId);
    if (state) state.ready = true;
    emitNav(tabId, webview);
  });
  webview.addEventListener("did-start-loading", () => emitNav(tabId, webview, true));
  webview.addEventListener("did-stop-loading", () => emitNav(tabId, webview, false));
  webview.addEventListener("did-navigate", onNav);
  webview.addEventListener("did-navigate-in-page", (e: WebviewDomEvent) => {
    // In-page (SPA / hash) navigations only matter for the main frame.
    if (e.isMainFrame === false) return;
    emitNav(tabId, webview);
  });
  webview.addEventListener("page-title-updated", onNav);
  webview.addEventListener("did-fail-load", () => emitNav(tabId, webview, false));

  webview.addEventListener("page-favicon-updated", (e: WebviewDomEvent) => {
    const faviconUrl = e.favicons?.[0];
    if (!faviconUrl || !isReady(webview)) return;
    const event: BrowserFaviconEvent = { tabId, pageUrl: webview.getURL(), faviconUrl };
    for (const sub of registry.faviconSubs) sub(event);
  });

  webview.addEventListener("found-in-page", (e: WebviewDomEvent) => {
    if (!e.result) return;
    const event: BrowserFindEvent = {
      tabId,
      active: e.result.activeMatchOrdinal,
      total: e.result.matches,
    };
    for (const sub of registry.findSubs) sub(event);
  });

  // target="_blank" / window.open: open a Grove browser tab instead of a native
  // window (allowpopups is off, so no OS window is created regardless).
  webview.addEventListener("new-window", (e: WebviewDomEvent) => {
    const url = e.url;
    if (!url || !isAllowedBrowserUrl(url) || url === "about:blank") return;
    const event: BrowserNewWindowEvent = { openerTabId: tabId, url };
    for (const sub of registry.newWindowSubs) sub(event);
  });
}

/** Create the `<webview>` once both a host and a desired URL exist. */
function reconcile(tabId: string): void {
  const state = registry.guests.get(tabId);
  if (!state || state.webview || !state.host || !state.url) return;

  const webview = document.createElement("webview") as BrowserWebviewElement;
  webview.setAttribute("partition", BROWSER_PARTITION);
  webview.style.display = state.visible ? "flex" : "none";
  webview.style.flex = "1";
  webview.style.width = "100%";
  webview.style.height = "100%";
  webview.style.border = "none";
  // Some pages never paint a background; white matches normal browser behavior
  // instead of leaking Grove chrome through the guest.
  webview.style.background = "#ffffff";
  wireWebviewEvents(tabId, webview);
  state.webview = webview;
  state.ready = false;
  // Attach first, then set src — the guest begins loading once the element is in
  // the document, and the load-start events reach our already-wired listeners.
  state.host.appendChild(webview);
  // Navigate via the `src` PROPERTY (not setAttribute) — orca does the same;
  // the property setter reliably drives the guest's initial navigation.
  webview.src = state.url;
}

function teardown(tabId: string): void {
  const state = registry.guests.get(tabId);
  if (!state) return;
  state.webview?.remove();
  registry.guests.delete(tabId);
}

// ── Host registration (called by BrowserPanel via @platform) ─────────────────

export function registerBrowserHostDom(tabId: string, el: HTMLElement | null): void {
  // PARK on unregister — NEVER destroy here. LANDMINE: React re-runs this
  // effect (StrictMode double-invoke in dev; dep changes in prod) as
  // set → null → set within one commit. Tearing the guest down on the null
  // pass would delete its URL and remove the `<webview>` (destroying the
  // Electron guest), and the immediate re-register could not rebuild it. Real
  // teardown happens only on explicit tab close via domBrowserClose.
  if (!el) return;

  const state = getState(tabId);
  state.host = el;
  const prev = state.webview;
  // Same live guest already mounted in this host node — keep it (the common
  // StrictMode remount path: the host div's DOM identity is unchanged).
  if (prev && prev.parentElement === el) return;
  // Otherwise the previous guest is stale — its host div unmounted (worktree
  // switch), so React already detached the `<webview>` and Electron destroyed
  // the guest. Rebuild fresh from the remembered URL.
  if (prev) {
    prev.remove();
    state.webview = null;
    state.ready = false;
  }
  reconcile(tabId);
}

// ── Control (called by @platform browser command wrappers) ───────────────────

export function domBrowserCreate(tabId: string, url: string): void {
  const state = getState(tabId);
  state.url = url;
  state.visible = true;
  if (state.webview) {
    // Assigning `src` navigates safely at any point in the guest lifecycle,
    // unlike loadURL() which throws before `dom-ready`.
    if (state.webview.src !== url) state.webview.src = url;
  } else {
    reconcile(tabId);
  }
}

export function domBrowserNavigate(tabId: string, url: string): void {
  const state = registry.guests.get(tabId);
  if (!state) return;
  state.url = url;
  if (state.webview) {
    if (state.webview.src !== url) state.webview.src = url;
  } else {
    reconcile(tabId);
  }
}

/** Resolve a guest's webview only when its methods are live (post dom-ready). */
function readyWebview(tabId: string): BrowserWebviewElement | null {
  const wv = registry.guests.get(tabId)?.webview;
  return wv && isReady(wv) ? wv : null;
}

export function domBrowserGoBack(tabId: string): void {
  const wv = readyWebview(tabId);
  if (wv && wv.canGoBack()) wv.goBack();
}

export function domBrowserGoForward(tabId: string): void {
  const wv = readyWebview(tabId);
  if (wv && wv.canGoForward()) wv.goForward();
}

export function domBrowserReload(tabId: string): void {
  readyWebview(tabId)?.reload();
}

export function domBrowserOpenDevtools(tabId: string): void {
  readyWebview(tabId)?.openDevTools();
}

export function domBrowserSetVisible(tabId: string, visible: boolean): void {
  const state = registry.guests.get(tabId);
  if (!state) return;
  state.visible = visible;
  if (state.webview) state.webview.style.display = visible ? "flex" : "none";
}

export function domBrowserClose(tabId: string): void {
  teardown(tabId);
}

export function domBrowserCloseAll(): void {
  // Snapshot keys — teardown() mutates the map during iteration.
  for (const tabId of Array.from(registry.guests.keys())) teardown(tabId);
}

export function domBrowserFind(
  tabId: string,
  query: string,
  forward: boolean,
  findNext: boolean,
): void {
  const wv = readyWebview(tabId);
  if (!wv) return;
  if (!query) {
    wv.stopFindInPage("clearSelection");
    return;
  }
  wv.findInPage(query, { forward, findNext });
}

export function domBrowserStopFind(tabId: string): void {
  readyWebview(tabId)?.stopFindInPage("clearSelection");
}

// ── Event subscription (called by @platform on* wrappers) ────────────────────

export function onDomBrowserNav(handler: NavSub): UnlistenFn {
  registry.navSubs.add(handler);
  return () => registry.navSubs.delete(handler);
}

export function onDomBrowserNewWindow(handler: NewWindowSub): UnlistenFn {
  registry.newWindowSubs.add(handler);
  return () => registry.newWindowSubs.delete(handler);
}

/**
 * Emit a new-window request. Electron 33 removed the `<webview>` `new-window`
 * DOM event, so target=_blank / window.open is caught by a main-process
 * setWindowOpenHandler and pumped here by the electron platform bridge.
 */
export function emitDomBrowserNewWindow(event: BrowserNewWindowEvent): void {
  for (const sub of registry.newWindowSubs) sub(event);
}

export function onDomBrowserFavicon(handler: FaviconSub): UnlistenFn {
  registry.faviconSubs.add(handler);
  return () => registry.faviconSubs.delete(handler);
}

export function onDomBrowserFind(handler: FindSub): UnlistenFn {
  registry.findSubs.add(handler);
  return () => registry.findSubs.delete(handler);
}

export function onDomBrowserFindOpen(handler: FindOpenSub): UnlistenFn {
  registry.findOpenSubs.add(handler);
  return () => registry.findOpenSubs.delete(handler);
}
