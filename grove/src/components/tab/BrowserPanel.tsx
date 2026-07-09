import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  History,
  Loader2,
  RotateCw,
  SquareCode,
} from "lucide-react";
import { cn } from "../../lib/cn";
import { IconButton } from "../ui/button";
import { useBrowserStore, selectNav } from "../../store/browser";
import { useTabStore } from "../../store/tab";
import { normalizeBrowserUrl, browserTabTitle } from "../../lib/browser-url";
import { filterUrlSuggestions, findUrlCompletion } from "../../lib/browser-history";
import { runCommand } from "../../lib/command";
import { openExternal } from "../../lib/platform";
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

const QUICK_URLS = [
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:8080",
];

interface BrowserPanelProps {
  tabId: string;
  isActive: boolean;
}

function readHostBounds(el: HTMLDivElement | null) {
  if (!el) return { x: 0, y: 0, width: 0, height: 0 };
  const rect = el.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function BrowserPanel({ tabId, isActive }: BrowserPanelProps) {
  const nav = useBrowserStore(selectNav(tabId));
  const navigate = useBrowserStore((s) => s.navigate);
  const recentUrls = useBrowserStore((s) => s.recentUrls);
  const recordRecentUrl = useBrowserStore((s) => s.recordRecentUrl);
  const updateTabTitle = useTabStore((s) => s.updateTabTitle);
  const overlayOpen = useOverlayPresence();

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
  const isComposingRef = useRef(false);

  // Programmatic value + selection changes flow through here. React won't
  // rewrite a controlled input's DOM value when the state string is unchanged
  // (e.g. typing "a" into "loc|alhost…" yields the same display), so we force
  // the DOM value and then apply the selection in a layout effect. A monotonic
  // tick guarantees the effect runs even when `input` is byte-identical.
  const pendingRef = useRef<{ value: string; start: number; end: number } | null>(
    null,
  );
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

  // Dropdown filtering is always driven by the TYPED text, never the completed
  // text — an inline completion must not narrow the suggestion list.
  const suggestions = useMemo(
    () => filterUrlSuggestions(recentUrls, typed),
    [recentUrls, typed],
  );

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
      const normalized = normalizeBrowserUrl(raw);
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
      recordRecentUrl(normalized);
      setSuggestOpen(false);
      setHighlightIndex(-1);
      setCompletion(null);
      inputRef.current?.blur();
    },
    [navigate, recordRecentUrl, tabId, updateTabTitle],
  );

  // Cycle the dropdown highlight through [-1, 0 … n-1]. Index -1 means "no
  // selection". Arrows ONLY move the highlight — the input text is filled by
  // Enter (navigate) or Tab (complete), never by merely browsing the list.
  const moveHighlight = useCallback(
    (delta: 1 | -1) => {
      const len = suggestions.length;
      if (len === 0) return;
      let next = highlightIndex + delta;
      if (next < -1) next = len - 1;
      else if (next >= len) next = -1;
      setHighlightIndex(next);
    },
    [highlightIndex, suggestions.length],
  );

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // Never intercept keys while an IME composition is active — Enter/arrows
      // belong to the candidate window, and touching the value corrupts input.
      if (e.nativeEvent.isComposing) return;

      const highlighted =
        suggestOpen && highlightIndex >= 0 && highlightIndex < suggestions.length
          ? suggestions[highlightIndex]
          : null;
      const showingCompletion =
        completion !== null && input === completion.display;

      if (e.key === "Tab") {
        // Accept, never navigate, never move focus away.
        e.preventDefault();
        if (highlighted !== null) {
          setCompletion({ url: highlighted, display: highlighted });
          setTyped(highlighted);
          setHighlightIndex(-1);
          applyDisplay(highlighted, highlighted.length, highlighted.length);
        } else if (showingCompletion) {
          // Keep `completion` set so a following Enter loads the real URL.
          setTyped(completion.display);
          setHighlightIndex(-1);
          applyDisplay(
            completion.display,
            completion.display.length,
            completion.display.length,
          );
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
        if (!suggestOpen || suggestions.length === 0) return;
        e.preventDefault();
        moveHighlight(1);
        return;
      }

      if (e.key === "ArrowUp") {
        if (!suggestOpen || suggestions.length === 0) return;
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
      suggestions,
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

  const handleOpenExternal = useCallback(() => {
    if (!url) return;
    void runCommand(() => openExternal(url), {
      errorToast: "Failed to open in external browser",
    });
  }, [url]);

  // Keep the native webview positioned over the host area whenever it is the
  // active, visible tab. Also runs on remount (worktree switch) so a persisted
  // native webview snaps back to the right place.
  useEffect(() => {
    if (!hasNav || !isActive) return;
    const el = hostRef.current;
    if (!el) return;
    let rafId = 0;
    const sync = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0) return; // hidden — skip
      syncBrowserBounds(tabId, {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      });
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
  }, [hasNav, isActive, tabId]);

  // Drive native webview visibility. Hidden when inactive, when no page is
  // loaded, when an overlay covers it, when the URL suggestions dropdown is
  // open (it renders in the DOM, under the native view), or when the OS
  // window is hidden.
  //
  // This is also where a missing webview gets recreated (idle eviction, native
  // crash): recreation must retrigger on every signal that can end a hide —
  // tab activation, overlay/suggestions closing, the OS window becoming
  // visible again — and this effect is the one place that already watches all
  // of them. It never fights commit(), which flips isBrowserWebviewCreated
  // synchronously before the store update lands.
  const suggestionsShowing = suggestOpen && suggestions.length > 0;
  useEffect(() => {
    const apply = () => {
      const visible =
        isActive &&
        hasNav &&
        !overlayOpen &&
        !suggestionsShowing &&
        document.visibilityState === "visible";
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
  }, [hasNav, isActive, overlayOpen, suggestionsShowing, tabId, url]);

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
            <Globe className={cn("size-3 shrink-0 text-muted-foreground")} />
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
                  const match = findUrlCompletion(recentUrls, value);
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

          {suggestOpen && suggestions.length > 0 && (
            <div
              className={cn(
                "absolute inset-x-0 top-full z-50 mt-1 overflow-hidden rounded-md border border-border bg-popover p-1 shadow-md",
              )}
            >
              {suggestions.map((suggestion, index) => (
                <button
                  key={suggestion}
                  type="button"
                  // Keep input focus so onBlur doesn't swallow the click
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => commit(suggestion)}
                  onMouseEnter={() => setHighlightIndex(index)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors",
                    {
                      "bg-accent text-accent-foreground": index === highlightIndex,
                      "text-foreground": index !== highlightIndex,
                    },
                  )}
                >
                  <History
                    className={cn("size-3 shrink-0 text-muted-foreground")}
                  />
                  <span className={cn("truncate")}>{suggestion}</span>
                </button>
              ))}
            </div>
          )}
        </form>

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
                {recentUrls.length > 0
                  ? "Enter a URL above, or pick up where you left off"
                  : "Enter a URL above, or jump to a local dev server"}
              </p>
            </div>
            <div className={cn("flex max-w-md flex-wrap items-center justify-center gap-1.5")}>
              {(recentUrls.length > 0 ? recentUrls.slice(0, 3) : QUICK_URLS).map(
                (quickUrl) => (
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
                ),
              )}
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
