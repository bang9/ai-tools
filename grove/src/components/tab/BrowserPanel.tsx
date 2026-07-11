import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Crosshair,
  ExternalLink,
  File,
  Globe,
  Loader2,
  Lock,
  RotateCw,
  Search,
  ShieldAlert,
  SquareCode,
  X,
} from "lucide-react";
import { cn } from "../../lib/cn";
import { IconButton } from "../ui/button";
import { useBrowserStore, selectNav } from "../../store/browser";
import { useTabStore } from "../../store/tab";
import { useTerminalStore } from "../../store/terminal";
import { useToast } from "../../store/toast";
import {
  browserTabTitle,
  buildSearchUrl,
  looksLikeSearchQuery,
  resolveAddressInput,
  urlSecurity,
  type UrlSecurity,
} from "../../lib/browser-url";
import {
  buildSuggestions,
  findInlineCompletion,
  type BrowserHistoryEntry,
} from "../../lib/browser-history";
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  normalizePasteNewlines,
  sanitizeBracketedPasteText,
} from "../../lib/terminal-bracketed-paste";
import { runCommand } from "../../lib/command";
import {
  browserFind,
  browserSetGrabMode,
  browserStopFind,
  onBrowserFavicon,
  onBrowserFind,
  onBrowserFindOpen,
  onBrowserGrab,
  openExternal,
  writePty,
  type BrowserFaviconEvent,
  type BrowserFindEvent,
  type BrowserGrabEvent,
} from "../../lib/platform";
import {
  browserBack,
  browserForward,
  browserOpenDevtoolsTab,
  browserReloadTab,
  createBrowserWebview,
  initBrowserWebviewBridge,
  isBrowserWebviewCreated,
  navigateBrowser,
  setBrowserVisible,
  syncBrowserBounds,
} from "../../lib/browser-webview";
import { useOverlayPresence } from "../../hooks/useOverlayPresence";

const QUICK_URLS = ["http://localhost:3000", "http://localhost:5173", "http://localhost:8080"];

interface BrowserPanelProps {
  tabId: string;
  isActive: boolean;
}

function readHostBounds(el: HTMLDivElement | null) {
  if (!el) return { x: 0, y: 0, width: 0, height: 0 };
  const rect = el.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

/** Shape of the JSON payload posted by the guest grab picker (browser.rs). */
interface GrabPayload {
  tag: string;
  selector: string;
  text: string;
  html: string;
  pageUrl: string;
  pageTitle: string;
}

/** Render a picked element as compact markdown for a coding agent's terminal. */
function formatGrabMarkdown(p: GrabPayload): string {
  const text = (p.text ?? "").replace(/\s+/g, " ").trim();
  const label = p.pageTitle || p.pageUrl;
  return (
    `Browser element from [${label}](${p.pageUrl}):\n` +
    `- selector: \`${p.selector}\`  (tag \`${p.tag}\`)\n` +
    `- text: ${text}\n\n` +
    "```html\n" +
    `${p.html}\n` +
    "```\n"
  );
}

/** A row in the address-bar dropdown: a web-search action or a history hit. */
type AddressRow =
  | { kind: "history"; entry: BrowserHistoryEntry }
  | { kind: "search"; query: string; url: string };

/** The URL a row navigates to when chosen. */
function rowUrl(row: AddressRow): string {
  return row.kind === "search" ? row.url : row.entry.url;
}

/** Browser-style display URL: drop the scheme and a trailing slash. */
function prettyUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

/** Address-bar leading icon reflecting the loaded page's transport security. */
function SecurityIcon({ security }: { security: UrlSecurity }) {
  const base = "size-3 shrink-0";
  if (security === "secure") return <Lock className={cn(base, "text-muted-foreground")} />;
  if (security === "insecure")
    return (
      <span title="Not secure (HTTP)" className={cn("flex")}>
        <ShieldAlert className={cn(base, "text-amber-500/80")} />
      </span>
    );
  if (security === "file") return <File className={cn(base, "text-muted-foreground")} />;
  return <Globe className={cn(base, "text-muted-foreground")} />;
}

/** A page favicon, falling back to a globe glyph when absent or broken. */
function Favicon({ src, className }: { src?: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return <Globe className={cn("size-3.5 shrink-0 text-muted-foreground", className)} />;
  }
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      className={cn("size-3.5 shrink-0 rounded-sm object-contain", className)}
      onError={() => setFailed(true)}
    />
  );
}

function BrowserPanel({ tabId, isActive }: BrowserPanelProps) {
  const nav = useBrowserStore(selectNav(tabId));
  const navigate = useBrowserStore((s) => s.navigate);
  const history = useBrowserStore((s) => s.history);
  const recordFaviconInHistory = useBrowserStore((s) => s.recordFavicon);
  const updateTabTitle = useTabStore((s) => s.updateTabTitle);
  const updateTabFavicon = useTabStore((s) => s.updateTabFavicon);
  const overlayOpen = useOverlayPresence();
  const { toast } = useToast();
  const [grabArmed, setGrabArmed] = useState(false);
  // Guards against a picked element being delivered more than once (e.g. a
  // grab nav that fires the handler twice): drop an identical payload seen
  // within a short window.
  const lastGrabRef = useRef<{ data: string; at: number } | null>(null);

  // Find-in-page. The native webview owns the highlight/scroll; the app only
  // drives the query and shows the match ordinal reported back over onBrowserFind.
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findResult, setFindResult] = useState<{ active: number; total: number } | null>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const findDebounceRef = useRef<number | null>(null);

  // `input` is what the <input> DISPLAYS (may include an inline completion or a
  // dropdown preview). `typed` is what the user actually typed — it drives the
  // dropdown filter and the completion base, and is what we restore to.
  const [input, setInput] = useState(nav?.url ?? "");
  const [typed, setTyped] = useState(nav?.url ?? "");
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  // The currently showing (or Tab-accepted) inline completion. `display` is the
  // full text in the input; `url` is the real, navigable URL Enter must load.
  const [completion, setCompletion] = useState<{
    url: string;
    display: string;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const suggestRef = useRef<HTMLDivElement>(null);
  const isComposingRef = useRef(false);

  // Programmatic value + selection changes flow through here. React won't
  // rewrite a controlled input's DOM value when the state string is unchanged
  // (e.g. typing "a" into "loc|alhost…" yields the same display), so we force
  // the DOM value and then apply the selection in a layout effect. A monotonic
  // tick guarantees the effect runs even when `input` is byte-identical.
  const pendingRef = useRef<{ value: string; start: number; end: number } | null>(null);
  const [applyTick, setApplyTick] = useState(0);
  const applyDisplay = useCallback((value: string, start: number, end: number) => {
    pendingRef.current = { value, start, end };
    setInput(value);
    setApplyTick((t) => t + 1);
  }, []);
  useLayoutEffect(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    const el = inputRef.current;
    if (!el) return;
    if (el.value !== pending.value) el.value = pending.value;
    el.setSelectionRange(pending.start, pending.end);
  }, [applyTick]);

  // Dropdown suggestions are frecency-ranked and always driven by the TYPED
  // text, never the completed text — an inline completion must not narrow the
  // list. Entries carry title + favicon for richer rows.
  const suggestions = useMemo<BrowserHistoryEntry[]>(
    () => buildSuggestions(history, typed, Date.now()),
    [history, typed],
  );

  // Most-frecent sites for the empty-state quick links.
  const topSites = useMemo(
    () => buildSuggestions(history, "", Date.now(), 3).map((entry) => entry.url),
    [history],
  );

  // Address-bar dropdown rows: a leading "search the web" action (when the typed
  // text reads as a query) followed by frecency-ranked history. `url` is what
  // Enter/click navigates to for either kind.
  const rows = useMemo<AddressRow[]>(() => {
    const historyRows: AddressRow[] = suggestions.map((entry) => ({ kind: "history", entry }));
    const q = typed.trim();
    if (q && looksLikeSearchQuery(q)) {
      return [{ kind: "search", query: q, url: buildSearchUrl(q) }, ...historyRows];
    }
    return historyRows;
  }, [suggestions, typed]);

  const security = urlSecurity(nav?.url ?? null);

  const url = nav?.url ?? null;
  const hasNav = !!nav;
  const loading = nav?.loading ?? false;
  const canGoBack = nav?.canGoBack ?? false;
  const canGoForward = nav?.canGoForward ?? false;

  // Wire native nav events into the store once (idempotent).
  useEffect(() => {
    initBrowserWebviewBridge();
  }, []);

  // Keep the address bar in sync with committed/native navigation — but never
  // clobber an in-progress edit (e.g. a redirect settling while the user is
  // typing). An abandoned edit is restored to the page URL on blur instead.
  useEffect(() => {
    if (document.activeElement === inputRef.current) return;
    const next = url ?? "";
    setInput(next);
    setTyped(next);
    setCompletion(null);
  }, [url]);

  const commit = useCallback(
    (raw: string) => {
      // Resolve to a URL — a non-URL query becomes a web search.
      const normalized = resolveAddressInput(raw);
      if (!normalized) return;
      if (!isBrowserWebviewCreated(tabId)) {
        // If the host div isn't mounted yet (start page still showing), this
        // reads zero bounds; the bounds-sync effect corrects it after mount.
        createBrowserWebview(tabId, normalized, readHostBounds(hostRef.current));
      } else {
        navigateBrowser(tabId, normalized);
      }
      navigate(tabId, normalized);
      updateTabTitle(tabId, browserTabTitle(normalized));
      // History is recorded by applyNavEvent when the page settles, so both
      // address-bar and link-click navigations are captured in one place.
      setSuggestOpen(false);
      setHighlightIndex(-1);
      setCompletion(null);
      inputRef.current?.blur();
    },
    [navigate, tabId, updateTabTitle],
  );

  // Cycle the dropdown highlight through [-1, 0 … n-1]. Index -1 means "no
  // selection". Arrows ONLY move the highlight — the input text is filled by
  // Enter (navigate) or Tab (complete), never by merely browsing the list.
  const moveHighlight = useCallback(
    (delta: 1 | -1) => {
      const len = rows.length;
      if (len === 0) return;
      let next = highlightIndex + delta;
      if (next < -1) next = len - 1;
      else if (next >= len) next = -1;
      setHighlightIndex(next);
    },
    [highlightIndex, rows.length],
  );

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // Never intercept keys while an IME composition is active — Enter/arrows
      // belong to the candidate window, and touching the value corrupts input.
      if (e.nativeEvent.isComposing) return;

      const highlightedRow =
        suggestOpen && highlightIndex >= 0 && highlightIndex < rows.length
          ? rows[highlightIndex]
          : null;
      const highlighted = highlightedRow ? rowUrl(highlightedRow) : null;
      const showingCompletion = completion !== null && input === completion.display;

      if (e.key === "Tab") {
        // Accept into the input, never navigate. Only history rows fill the bar
        // (accepting a full search URL into the bar would be odd).
        e.preventDefault();
        if (highlightedRow?.kind === "history") {
          const value = highlightedRow.entry.url;
          setCompletion({ url: value, display: value });
          setTyped(value);
          setHighlightIndex(-1);
          applyDisplay(value, value.length, value.length);
        } else if (showingCompletion) {
          // Keep `completion` set so a following Enter loads the real URL.
          setTyped(completion.display);
          setHighlightIndex(-1);
          applyDisplay(completion.display, completion.display.length, completion.display.length);
        }
        return;
      }

      if (e.key === "Enter") {
        if (highlighted !== null) {
          e.preventDefault();
          commit(highlighted);
        } else if (showingCompletion) {
          e.preventDefault();
          commit(completion.url);
        }
        // Otherwise let the form's onSubmit fire commit(input).
        return;
      }

      if (e.key === "ArrowDown") {
        if (!suggestOpen || rows.length === 0) return;
        e.preventDefault();
        moveHighlight(1);
        return;
      }

      if (e.key === "ArrowUp") {
        if (!suggestOpen || rows.length === 0) return;
        e.preventDefault();
        moveHighlight(-1);
        return;
      }

      if (e.key === "Escape") {
        if (suggestOpen) {
          // First Escape: drop any completion/preview, restore typed, close the
          // dropdown, keep focus.
          e.preventDefault();
          setSuggestOpen(false);
          setHighlightIndex(-1);
          setCompletion(null);
          applyDisplay(typed, typed.length, typed.length);
        } else {
          inputRef.current?.blur();
        }
      }
    },
    [
      applyDisplay,
      commit,
      completion,
      highlightIndex,
      input,
      moveHighlight,
      suggestOpen,
      rows,
      typed,
    ],
  );

  const handleReload = useCallback(() => {
    if (url) browserReloadTab(tabId);
  }, [tabId, url]);

  const handleBack = useCallback(() => {
    browserBack(tabId);
  }, [tabId]);

  const handleForward = useCallback(() => {
    browserForward(tabId);
  }, [tabId]);

  const handleOpenDevtools = useCallback(() => {
    // Frame restoration after the detach sequence is handled natively — the
    // Rust side re-applies the last synced bounds when the sequence settles.
    browserOpenDevtoolsTab(tabId);
  }, [tabId]);

  // Arm/disarm the guest element picker. Optimistically reflect the new state;
  // revert if the native call fails. The guest disarms itself after a pick, so
  // the grab event handler resets `grabArmed` on delivery.
  const handleToggleGrab = useCallback(() => {
    const next = !grabArmed;
    setGrabArmed(next);
    void runCommand(() => browserSetGrabMode(tabId, next), {
      errorToast: "Failed to toggle grab mode",
    }).catch(() => setGrabArmed(!next));
  }, [grabArmed, tabId]);

  // Deliver a picked element to the focused terminal (where a coding agent
  // runs). Subscribe once; ignore events for other tabs.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    const deliver = (event: BrowserGrabEvent) => {
      if (event.tabId !== tabId) return;
      // Drop a duplicate delivery of the same element within a short window.
      const now = Date.now();
      const last = lastGrabRef.current;
      if (last && last.data === event.data && now - last.at < 1500) return;
      lastGrabRef.current = { data: event.data, at: now };
      // The guest disarms itself after a pick — mirror that in the UI.
      setGrabArmed(false);
      let payload: GrabPayload;
      try {
        payload = JSON.parse(event.data) as GrabPayload;
      } catch {
        toast("error", "Failed to read grabbed element");
        return;
      }
      const focusedPtyId = useTerminalStore.getState().focusedPtyId;
      if (!focusedPtyId) {
        toast("error", "No focused terminal");
        return;
      }
      // Wrap as a single bracketed paste so the multi-line payload lands as ONE
      // block in the agent's input instead of each newline submitting a line.
      const markdown = normalizePasteNewlines(formatGrabMarkdown(payload));
      const wrapped =
        BRACKETED_PASTE_START + sanitizeBracketedPasteText(markdown) + BRACKETED_PASTE_END;
      const bytes = new TextEncoder().encode(wrapped);
      void writePty(focusedPtyId, bytes)
        .then(() => toast("success", "Sent element to terminal"))
        .catch(() => toast("error", "Failed to send element to terminal"));
    };
    void onBrowserGrab(deliver).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [tabId, toast]);

  const handleOpenExternal = useCallback(() => {
    if (!url) return;
    void runCommand(() => openExternal(url), {
      errorToast: "Failed to open in external browser",
    });
  }, [url]);

  // --- Find-in-page ---
  // The native webview owns the search/highlight (GUEST_FIND_SCRIPT); the app
  // drives the query and renders the match ordinal. Because the native view sits
  // ABOVE the DOM, the find bar can't overlay it — it renders as a docked row
  // that shrinks the webview host (the bounds-sync effect moves the view down).

  const openFind = useCallback(() => {
    setFindOpen(true);
    // Focus + select on the next frame, once the input is in the DOM.
    requestAnimationFrame(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    });
  }, []);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindResult(null);
    if (findDebounceRef.current !== null) {
      window.clearTimeout(findDebounceRef.current);
      findDebounceRef.current = null;
    }
    void browserStopFind(tabId).catch(() => {});
  }, [tabId]);

  // Debounce the live query so re-highlighting doesn't flash on every keystroke.
  const runFind = useCallback(
    (query: string) => {
      setFindQuery(query);
      if (findDebounceRef.current !== null) window.clearTimeout(findDebounceRef.current);
      if (!query) {
        setFindResult(null);
        void browserStopFind(tabId).catch(() => {});
        return;
      }
      findDebounceRef.current = window.setTimeout(() => {
        findDebounceRef.current = null;
        void browserFind(tabId, query, true, false).catch(() => {});
      }, 180);
    },
    [tabId],
  );

  const stepFind = useCallback(
    (forward: boolean) => {
      if (!findQuery) return;
      void browserFind(tabId, findQuery, forward, true).catch(() => {});
    },
    [findQuery, tabId],
  );

  const handleFindKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        stepFind(!e.shiftKey); // Enter = next, Shift+Enter = previous
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeFind();
      }
    },
    [closeFind, stepFind],
  );

  // Subscribe to match-count reports for this tab.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void onBrowserFind((event: BrowserFindEvent) => {
      if (event.tabId !== tabId) return;
      setFindResult({ active: event.active, total: event.total });
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [tabId]);

  // Open the find bar when the guest forwards a Cmd/Ctrl+F pressed over the page
  // (the native webview has focus, so the app frame never sees that keychord).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void onBrowserFindOpen((event) => {
      if (event.tabId !== tabId) return;
      openFind();
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [openFind, tabId]);

  // Cmd/Ctrl+F while focus is in the app chrome (address bar, toolbar). The
  // guest handler covers the case where the page itself has focus.
  useEffect(() => {
    if (!isActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        (e.key === "f" || e.key === "F")
      ) {
        e.preventDefault();
        openFind();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isActive, openFind]);

  // A navigation replaces the document (highlights are gone) — reset the bar.
  useEffect(() => {
    setFindOpen(false);
    setFindResult(null);
  }, [url]);

  // Favicon delivered by the guest: show it on the tab chip and remember it in
  // history so suggestion rows for this site carry the icon too.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void onBrowserFavicon((event: BrowserFaviconEvent) => {
      if (event.tabId !== tabId) return;
      updateTabFavicon(tabId, event.faviconUrl);
      if (event.pageUrl) recordFaviconInHistory(event.pageUrl, event.faviconUrl);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [recordFaviconInHistory, tabId, updateTabFavicon]);

  // Match ordinal shown in the find bar: "3/12", "No results", or blank.
  let findLabel = "";
  if (findQuery) {
    findLabel =
      findResult && findResult.total > 0
        ? `${findResult.active}/${findResult.total}`
        : "No results";
  }

  const suggestionsShowing = suggestOpen && rows.length > 0;

  // Keep the native webview positioned over the host area whenever it is the
  // active, visible tab. Also runs on remount (worktree switch) so a persisted
  // native webview snaps back to the right place.
  //
  // When the suggestions dropdown is open we do NOT hide the webview (that
  // blanks the whole page); instead we push the webview's top DOWN past the
  // dropdown's bottom edge, so the DOM dropdown shows in the reclaimed strip
  // and the page stays visible below it.
  useEffect(() => {
    if (!hasNav || !isActive) return;
    const el = hostRef.current;
    if (!el) return;
    let rafId = 0;
    const sync = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0) return; // hidden — skip
      let top = rect.y;
      let height = rect.height;
      const dd = suggestionsShowing ? suggestRef.current?.getBoundingClientRect() : null;
      if (dd) {
        const offset = Math.max(0, Math.min(dd.bottom - rect.y, rect.height));
        top = rect.y + offset;
        height = rect.height - offset;
      }
      syncBrowserBounds(tabId, { x: rect.x, y: top, width: rect.width, height });
    };
    const schedule = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(sync);
    };
    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(el);
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [hasNav, isActive, tabId, suggestionsShowing, rows.length]);

  // Drive native webview visibility. Hidden when inactive, when no page is
  // loaded, when an overlay covers it, or when the OS window is hidden. The
  // suggestions dropdown no longer hides it (see the bounds effect above).
  //
  // This is also where a missing webview gets recreated (idle eviction, native
  // crash): recreation must retrigger on every signal that can end a hide —
  // tab activation, overlay closing, the OS window becoming visible again —
  // and this effect is the one place that already watches all of them. It never
  // fights commit(), which flips isBrowserWebviewCreated synchronously before
  // the store update lands.
  useEffect(() => {
    const apply = () => {
      const visible = isActive && hasNav && !overlayOpen && document.visibilityState === "visible";
      if (visible && url && !isBrowserWebviewCreated(tabId)) {
        // Created visible over the host; the bounds-sync effect snaps it into
        // place right after.
        createBrowserWebview(tabId, url, readHostBounds(hostRef.current));
        return;
      }
      setBrowserVisible(tabId, visible);
    };
    apply();
    document.addEventListener("visibilitychange", apply);
    return () => {
      document.removeEventListener("visibilitychange", apply);
    };
  }, [hasNav, isActive, overlayOpen, tabId, url]);

  // Hide the native webview when this panel unmounts (e.g. tab closed or
  // worktree switched away). The webview itself persists until closeTab.
  useEffect(() => {
    return () => {
      setBrowserVisible(tabId, false);
    };
  }, [tabId]);

  return (
    <div className={cn("flex h-full flex-col")}>
      {/* Toolbar */}
      <div
        className={cn(
          "flex h-9 shrink-0 items-center gap-1 border-b border-border bg-sidebar px-2",
        )}
      >
        <IconButton
          onClick={handleBack}
          disabled={!canGoBack}
          title="Back"
          aria-label="Back"
          className={cn("h-6 w-6")}
        >
          <ArrowLeft className={cn("size-3.5")} />
        </IconButton>
        <IconButton
          onClick={handleForward}
          disabled={!canGoForward}
          title="Forward"
          aria-label="Forward"
          className={cn("h-6 w-6")}
        >
          <ArrowRight className={cn("size-3.5")} />
        </IconButton>
        <IconButton
          onClick={handleReload}
          disabled={!url}
          title="Reload"
          aria-label="Reload"
          className={cn("h-6 w-6")}
        >
          {loading ? (
            <Loader2 className={cn("size-3.5 animate-spin")} />
          ) : (
            <RotateCw className={cn("size-3.5")} />
          )}
        </IconButton>

        <form
          className={cn("relative min-w-0 flex-1")}
          onSubmit={(e) => {
            e.preventDefault();
            commit(input);
          }}
        >
          <div
            className={cn(
              "flex h-6 items-center gap-1.5 rounded-md border border-white/10 bg-background/60 px-2.5",
              "transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30",
            )}
          >
            <SecurityIcon security={security} />
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => {
                const value = e.target.value;
                setSuggestOpen(true);
                setHighlightIndex(-1);
                setTyped(value);
                // Only complete on INSERTION, never deletion — otherwise text
                // can't be removed. IME composition text is excluded too; a
                // mid-composition setSelectionRange corrupts Korean input.
                const inputType = (e.nativeEvent as InputEvent).inputType;
                const isInsert =
                  !isComposingRef.current &&
                  typeof inputType === "string" &&
                  inputType.startsWith("insert") &&
                  inputType !== "insertCompositionText";
                if (isInsert) {
                  const match = findInlineCompletion(history, value, Date.now());
                  if (match) {
                    const display = value + match.completion;
                    setCompletion({ url: match.url, display });
                    applyDisplay(display, value.length, display.length);
                    return;
                  }
                }
                setCompletion(null);
                setInput(value);
              }}
              onCompositionStart={() => {
                isComposingRef.current = true;
              }}
              onCompositionEnd={() => {
                isComposingRef.current = false;
              }}
              onFocus={(e) => {
                e.currentTarget.select();
                setSuggestOpen(true);
                setHighlightIndex(-1);
                setTyped(e.currentTarget.value);
                setCompletion(null);
              }}
              onBlur={() => {
                setSuggestOpen(false);
                setHighlightIndex(-1);
                setCompletion(null);
                // Abandoned edit — restore the page URL, like browsers do.
                const next = url ?? "";
                setInput(next);
                setTyped(next);
              }}
              onKeyDown={handleInputKeyDown}
              placeholder="Enter URL — e.g. localhost:3000"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              className={cn(
                "w-full min-w-0 bg-transparent text-xs text-foreground outline-none",
                "placeholder:text-muted-foreground/60",
              )}
            />
          </div>

          {suggestOpen && rows.length > 0 && (
            <div
              ref={suggestRef}
              className={cn(
                "absolute inset-x-0 top-full z-50 mt-1 overflow-hidden rounded-md border border-border bg-popover p-1 shadow-md",
              )}
            >
              {rows.map((row, index) => (
                <button
                  key={row.kind === "search" ? "__search__" : row.entry.normalizedUrl}
                  type="button"
                  // Keep input focus so onBlur doesn't swallow the click
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => commit(rowUrl(row))}
                  onMouseEnter={() => setHighlightIndex(index)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors",
                    {
                      "bg-accent text-accent-foreground": index === highlightIndex,
                      "text-foreground": index !== highlightIndex,
                    },
                  )}
                >
                  {row.kind === "search" ? (
                    <>
                      <Search className={cn("size-3.5 shrink-0 text-muted-foreground")} />
                      <span className={cn("min-w-0 flex-1 truncate")}>
                        <span>{row.query}</span>
                        <span className={cn("ml-2 text-muted-foreground/70")}>— Search</span>
                      </span>
                    </>
                  ) : (
                    <>
                      <Favicon src={row.entry.faviconUrl} />
                      <span className={cn("min-w-0 flex-1 truncate")}>
                        {row.entry.title ? (
                          <>
                            <span>{row.entry.title}</span>
                            <span className={cn("ml-2 text-muted-foreground/70")}>
                              {prettyUrl(row.entry.url)}
                            </span>
                          </>
                        ) : (
                          prettyUrl(row.entry.url)
                        )}
                      </span>
                    </>
                  )}
                </button>
              ))}
            </div>
          )}
        </form>

        <IconButton
          onClick={() => (findOpen ? closeFind() : openFind())}
          disabled={!url}
          title="Find in page (⌘F)"
          aria-label="Find in page"
          className={cn("h-6 w-6", { "text-primary": findOpen })}
        >
          <Search className={cn("size-3.5")} />
        </IconButton>
        <IconButton
          onClick={handleToggleGrab}
          disabled={!url}
          title="Grab an element into the terminal"
          aria-label="Grab an element into the terminal"
          className={cn("h-6 w-6", { "text-primary": grabArmed })}
        >
          <Crosshair className={cn("size-3.5")} />
        </IconButton>
        <IconButton
          onClick={handleOpenDevtools}
          disabled={!url}
          title="Open DevTools"
          aria-label="Open DevTools"
          className={cn("h-6 w-6")}
        >
          <SquareCode className={cn("size-3.5")} />
        </IconButton>
        <IconButton
          onClick={handleOpenExternal}
          disabled={!url}
          title="Open in external browser"
          aria-label="Open in external browser"
          className={cn("h-6 w-6")}
        >
          <ExternalLink className={cn("size-3.5")} />
        </IconButton>
      </div>

      {/* Find bar — a docked row (not an overlay: the native webview sits above
          the DOM). Rendering it shrinks the content host and the bounds-sync
          effect moves the webview down to make room. */}
      {findOpen && hasNav && (
        <div
          className={cn(
            "flex h-9 shrink-0 items-center gap-2 border-b border-border bg-sidebar px-2",
          )}
        >
          <Search className={cn("size-3.5 shrink-0 text-muted-foreground")} />
          <input
            ref={findInputRef}
            value={findQuery}
            onChange={(e) => runFind(e.target.value)}
            onKeyDown={handleFindKeyDown}
            placeholder="Find in page"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className={cn(
              "min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none",
              "placeholder:text-muted-foreground/60",
            )}
          />
          <span className={cn("shrink-0 text-[11px] tabular-nums text-muted-foreground")}>
            {findLabel}
          </span>
          <IconButton
            onClick={() => stepFind(false)}
            disabled={!findResult || findResult.total === 0}
            title="Previous match (⇧⏎)"
            aria-label="Previous match"
            className={cn("h-6 w-6")}
          >
            <ChevronUp className={cn("size-3.5")} />
          </IconButton>
          <IconButton
            onClick={() => stepFind(true)}
            disabled={!findResult || findResult.total === 0}
            title="Next match (⏎)"
            aria-label="Next match"
            className={cn("h-6 w-6")}
          >
            <ChevronDown className={cn("size-3.5")} />
          </IconButton>
          <IconButton
            onClick={closeFind}
            title="Close find (Esc)"
            aria-label="Close find"
            className={cn("h-6 w-6")}
          >
            <X className={cn("size-3.5")} />
          </IconButton>
        </div>
      )}

      {/* Content */}
      <div className={cn("relative min-h-0 flex-1")}>
        {hasNav ? (
          // Native webview host — the native layer is positioned over this div
          // via syncBrowserBounds. It renders nothing itself.
          <div ref={hostRef} className={cn("h-full w-full bg-background")} />
        ) : (
          <div
            className={cn(
              "flex h-full flex-col items-center justify-center gap-4 text-muted-foreground",
            )}
          >
            <div
              className={cn(
                "flex h-12 w-12 items-center justify-center rounded-xl border border-white/10 bg-white/5 shadow-sm",
              )}
            >
              <Globe className={cn("h-5 w-5")} />
            </div>
            <div className={cn("text-center")}>
              <p className={cn("text-sm font-medium text-foreground")}>Browser</p>
              <p className={cn("mt-1 text-xs")}>
                {topSites.length > 0
                  ? "Enter a URL above, or pick up where you left off"
                  : "Enter a URL above, or jump to a local dev server"}
              </p>
            </div>
            <div className={cn("flex max-w-md flex-wrap items-center justify-center gap-1.5")}>
              {(topSites.length > 0 ? topSites : QUICK_URLS).map((quickUrl) => (
                <button
                  key={quickUrl}
                  type="button"
                  onClick={() => commit(quickUrl)}
                  title={quickUrl}
                  className={cn(
                    "h-6 max-w-56 cursor-pointer truncate rounded-full border border-white/10 bg-white/5 px-2.5 text-[11px] font-medium",
                    "text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground",
                  )}
                >
                  {quickUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                </button>
              ))}
            </div>
            <p className={cn("text-[10px] text-muted-foreground/60")}>
              Some external sites may refuse to load in an embedded view
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

export default BrowserPanel;
