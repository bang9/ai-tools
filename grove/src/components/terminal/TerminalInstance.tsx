import {
  memo,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ChevronDown, ChevronUp, Columns2, Radio, Rows2, ScreenShare, Tag, X } from "lucide-react";
import { useTerminalStore } from "../../store/terminal";
import { useBroadcastStore } from "../../store/broadcast";
import { usePanelLayoutStore } from "../../store/panel-layout";
import "@xterm/xterm/css/xterm.css";
import { cn } from "../../lib/cn";
import { requestTerminalLayoutSync } from "../../lib/terminal-layout-sync";
import { acquireTerminalRuntime } from "../../lib/terminal-runtime";
import { countLeaves, TERMINAL_PANE_LABEL_MAX_LENGTH } from "../../lib/split-tree";
import {
  closeTerminalPane,
  mirrorTerminalPane,
  splitTerminalPane,
} from "../../lib/terminal-pane-commands";
import { shouldAttachPrimaryRuntime } from "../../lib/broadcast-policy";
import { restoreBroadcastSessionSize } from "../../lib/broadcast-session";
import { Button, IconButton } from "../ui/button";

interface Props {
  paneId: string;
  ptyId: string;
  worktreePath: string;
  tabId: string;
  label?: string;
}

/**
 * Pane header chip (top-right): label/memo plus the pane actions. The label
 * (when set) stays visible; the action buttons occupy no space until the pane
 * is hovered, then animate their width in. Without a label the whole chip is
 * hover-revealed.
 */
function TerminalPaneHeader({
  worktreePath,
  paneId,
  ptyId,
  paneCount,
  label,
  onLabelChange,
  onFocusTerminal,
}: {
  worktreePath: string;
  paneId: string;
  ptyId: string;
  paneCount: number;
  label?: string;
  onLabelChange: (label: string | undefined) => void;
  onFocusTerminal: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const skipBlurSaveRef = useRef(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label ?? "");

  useEffect(() => {
    if (!editing) {
      setDraft(label ?? "");
    }
  }, [editing, label]);

  useEffect(() => {
    if (!editing) return;
    skipBlurSaveRef.current = false;
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [editing]);

  const saveDraft = useCallback(() => {
    const next = draft.trim().slice(0, TERMINAL_PANE_LABEL_MAX_LENGTH);
    onLabelChange(next || undefined);
    setDraft(next);
    setEditing(false);
    onFocusTerminal();
  }, [draft, onLabelChange, onFocusTerminal]);

  const cancelEdit = useCallback(() => {
    skipBlurSaveRef.current = true;
    setDraft(label ?? "");
    setEditing(false);
    onFocusTerminal();
  }, [label, onFocusTerminal]);

  const stopTerminalFocus = (event: SyntheticEvent) => {
    event.stopPropagation();
  };

  const actionButtonClass =
    "inline-flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-white/45 hover:bg-white/10 hover:text-white/80";

  return (
    <div
      className={cn(
        "absolute right-2 top-2 z-20 flex h-6 max-w-[calc(100%-1rem)] items-center rounded-md border border-white/15 bg-white/10 px-0.5 text-white/75 backdrop-blur-sm transition-opacity duration-150",
        {
          "opacity-0 focus-within:opacity-100 group-hover/terminal-pane:opacity-100":
            !label && !editing,
        },
      )}
      onClick={stopTerminalFocus}
      onMouseDown={stopTerminalFocus}
    >
      {editing ? (
        <input
          ref={inputRef}
          type="text"
          value={draft}
          maxLength={TERMINAL_PANE_LABEL_MAX_LENGTH}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            if (skipBlurSaveRef.current) {
              skipBlurSaveRef.current = false;
              return;
            }
            saveDraft();
          }}
          onKeyDown={(event) => {
            // An Enter that only confirms an IME candidate must not commit.
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") {
              event.preventDefault();
              saveDraft();
            } else if (event.key === "Escape") {
              event.preventDefault();
              cancelEdit();
            }
          }}
          aria-label="Terminal pane label"
          placeholder="Label"
          className={cn(
            "h-5 w-28 bg-transparent px-1.5 text-xs font-medium text-white/80 outline-none placeholder:text-white/35",
          )}
        />
      ) : (
        label && (
          <button
            type="button"
            className={cn(
              "min-w-0 cursor-pointer truncate px-1.5 text-left text-xs font-medium leading-5",
            )}
            onClick={() => setEditing(true)}
            title={label}
          >
            {label}
          </button>
        )
      )}
      <div
        className={cn("flex items-center gap-0.5 overflow-hidden transition-all duration-150", {
          "max-w-0 opacity-0 focus-within:max-w-44 focus-within:opacity-100 group-hover/terminal-pane:max-w-44 group-hover/terminal-pane:opacity-100":
            Boolean(label) && !editing,
          "max-w-44 opacity-100": !label || editing,
        })}
      >
        {!label && !editing && (
          <button
            type="button"
            className={cn(actionButtonClass)}
            onClick={() => setEditing(true)}
            title="Add label"
          >
            <Tag className={cn("h-3 w-3")} />
          </button>
        )}
        <button
          type="button"
          className={cn(actionButtonClass)}
          onClick={() => {
            mirrorTerminalPane(paneId, ptyId);
          }}
          title="Mirror to Global Terminal"
        >
          <ScreenShare className={cn("h-3 w-3")} />
        </button>
        <button
          type="button"
          className={cn(actionButtonClass)}
          onClick={() => {
            splitTerminalPane(worktreePath, ptyId, "vertical").catch(() => {});
          }}
          title="Split Vertical"
        >
          <Rows2 className={cn("h-3 w-3")} />
        </button>
        <button
          type="button"
          className={cn(actionButtonClass)}
          onClick={() => {
            splitTerminalPane(worktreePath, ptyId, "horizontal").catch(() => {});
          }}
          title="Split Horizontal"
        >
          <Columns2 className={cn("h-3 w-3")} />
        </button>
        {paneCount > 1 && (
          <button
            type="button"
            className={cn(actionButtonClass)}
            onClick={() => {
              closeTerminalPane(worktreePath, ptyId).catch(() => {});
            }}
            title="Close Terminal"
          >
            <X className={cn("h-3 w-3")} />
          </button>
        )}
      </div>
    </div>
  );
}

function TerminalInstance({ paneId, ptyId, worktreePath, tabId, label }: Props) {
  const termRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<ReturnType<typeof acquireTerminalRuntime> | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const theme = useTerminalStore((s) => s.theme);
  const isFocused = useTerminalStore((s) => s.focusedPtyId === ptyId);
  const isActiveWorktree = useTerminalStore((s) => s.activeWorktree === worktreePath);
  const isActiveTab = useTerminalStore((s) => s.sessions[worktreePath]?.activeTabId === tabId);
  const setFocusedPtyId = useTerminalStore((s) => s.setFocusedPtyId);
  const setPaneLabel = useTerminalStore((s) => s.setPaneLabel);
  const mirrorSession = useBroadcastStore((s) => s.mirrors[ptyId] ?? null);
  const pipSession = useBroadcastStore((s) => {
    const worktreePath = s.pipOwnerByPtyId[ptyId];
    return worktreePath ? (s.pips[worktreePath] ?? null) : null;
  });
  const isBroadcasting = Boolean(mirrorSession || pipSession);
  const snapshot = mirrorSession?.snapshot ?? pipSession?.snapshot ?? null;
  const paneCount = useTerminalStore((s) => {
    const tab = s.sessions[worktreePath]?.tabs.find((entry) => entry.id === tabId);
    return tab ? countLeaves(tab.node) : 0;
  });
  const markBellPty = useTerminalStore((s) => s.markBellPty);
  const [error, setError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchTerm("");
    runtimeRef.current?.clearSearch();
    runtimeRef.current?.focus();
  }, []);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, []);

  const handleClick = useCallback(() => {
    setFocusedPtyId(ptyId);
    runtimeRef.current?.focus();
  }, [ptyId, setFocusedPtyId]);

  const handlePaneLabelChange = useCallback(
    (nextLabel: string | undefined) => {
      setPaneLabel(worktreePath, paneId, nextLabel);
    },
    [paneId, setPaneLabel, worktreePath],
  );

  useLayoutEffect(() => {
    const container = termRef.current;
    if (!container || !shouldAttachPrimaryRuntime(isBroadcasting)) {
      runtimeRef.current = null;
      return;
    }

    const runtime = acquireTerminalRuntime(paneId, theme);
    runtimeRef.current = runtime;
    runtime.setPtyId(ptyId);
    runtime.setFocusHandler((nextPtyId) => {
      setFocusedPtyId(nextPtyId);
    });
    runtime.setErrorHandler(setError);
    runtime.setBellHandler(markBellPty);
    runtime.setSearchHandler(openSearch);
    runtime.attach(container);
    requestTerminalLayoutSync({ paneId, source: "attach" });

    return () => {
      runtime.setFocusHandler(null);
      runtime.setErrorHandler(null);
      runtime.setBellHandler(null);
      runtime.setSearchHandler(null);
      runtime.detach(container);
      runtime.release();
      runtimeRef.current = null;
    };
  }, [isBroadcasting, markBellPty, openSearch, paneId, setFocusedPtyId, theme]);

  useEffect(() => {
    runtimeRef.current?.setPtyId(ptyId);
  }, [ptyId]);

  // Suspend the hidden pane's WebGL context (display:none while its worktree
  // or terminal tab is inactive) and reload it on reveal. isBroadcasting is a
  // dep so the flag re-pushes after the runtime is (re)acquired when
  // broadcasting toggles.
  useEffect(() => {
    runtimeRef.current?.setVisible(isActiveWorktree && isActiveTab);
  }, [isActiveTab, isActiveWorktree, isBroadcasting]);

  useEffect(() => {
    runtimeRef.current?.setTheme(theme);
  }, [theme]);

  useEffect(() => {
    requestTerminalLayoutSync({ source: "broadcast" });
  }, [isBroadcasting]);

  if (error) {
    return (
      <div className={cn("absolute inset-0 p-3 text-sm text-[var(--color-danger)]")}>{error}</div>
    );
  }

  return (
    <div
      className={cn("terminal-pane group/terminal-pane absolute inset-0 p-4", {
        "terminal-pane-focused": isFocused,
      })}
      style={{ backgroundColor: theme?.background ?? "#000" }}
      onClick={handleClick}
    >
      <div ref={termRef} className={cn("terminal-instance h-full w-full")} />
      {/* The search box and the broadcast overlay both claim the same top-right
          corner, so the pane header yields to them. */}
      {!searchOpen && !isBroadcasting && (
        <TerminalPaneHeader
          worktreePath={worktreePath}
          paneId={paneId}
          ptyId={ptyId}
          paneCount={paneCount}
          label={label}
          onLabelChange={handlePaneLabelChange}
          onFocusTerminal={() => {
            setFocusedPtyId(ptyId);
            runtimeRef.current?.focus();
          }}
        />
      )}
      {searchOpen && (
        <div
          className={cn(
            "absolute top-2 right-4 z-20 flex items-center gap-1 rounded-md border border-border bg-sidebar px-2 py-1 shadow-lg",
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <input
            ref={searchInputRef}
            type="text"
            value={searchTerm}
            onChange={(e) => {
              setSearchTerm(e.target.value);
              if (e.target.value) {
                runtimeRef.current?.findNext(e.target.value);
              } else {
                runtimeRef.current?.clearSearch();
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                closeSearch();
              } else if (e.key === "Enter" && searchTerm) {
                if (e.shiftKey) {
                  runtimeRef.current?.findPrevious(searchTerm);
                } else {
                  runtimeRef.current?.findNext(searchTerm);
                }
              }
            }}
            className={cn(
              "h-6 w-40 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground",
            )}
            placeholder="Search..."
          />
          <IconButton
            className={cn("h-5 w-5")}
            onClick={() => searchTerm && runtimeRef.current?.findPrevious(searchTerm)}
            title="Previous (Shift+Enter)"
          >
            <ChevronUp className={cn("h-3 w-3")} />
          </IconButton>
          <IconButton
            className={cn("h-5 w-5")}
            onClick={() => searchTerm && runtimeRef.current?.findNext(searchTerm)}
            title="Next (Enter)"
          >
            <ChevronDown className={cn("h-3 w-3")} />
          </IconButton>
          <IconButton className={cn("h-5 w-5")} onClick={closeSearch} title="Close (Esc)">
            <X className={cn("h-3 w-3")} />
          </IconButton>
        </div>
      )}
      <div className={cn("terminal-pane-dim", { "terminal-pane-dim-active": !isFocused })} />
      {isBroadcasting && (
        <div className={cn("absolute inset-0 z-10")}>
          {/* Frozen terminal snapshot */}
          {snapshot && (
            <img src={snapshot} alt="" className={cn("absolute inset-4 pointer-events-none")} />
          )}
          {/* Blurred overlay on top of snapshot */}
          <div
            className={cn(
              "absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/40 backdrop-blur-[1.3px]",
            )}
          >
            <Radio className={cn("size-10 text-white animate-pulse")} />
            <span className={cn("text-lg font-black text-white tracking-wide")}>Broadcasting</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const { mirrors, stopMirror, stopPipByPty } = useBroadcastStore.getState();

                if (mirrors[ptyId]) {
                  const ended = stopMirror(ptyId);
                  restoreBroadcastSessionSize(ended);
                  const gt = usePanelLayoutStore.getState().globalTerminal;
                  const mirrorTab = gt.tabs.find((t) => t.mirrorPtyId === ended?.ptyId);
                  if (mirrorTab) {
                    usePanelLayoutStore.getState().removeGlobalTerminalTab(mirrorTab.id);
                  }
                  return;
                }

                if (pipSession?.ptyId === ptyId) {
                  const ended = stopPipByPty(ptyId);
                  restoreBroadcastSessionSize(ended?.session ?? null);
                }
              }}
              className={cn(
                "mt-1 h-auto border-white/15 bg-white/5 px-2 py-1 text-xs text-white/60 hover:border-white/25 hover:bg-white/10 hover:text-white",
              )}
            >
              Stop
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(
  TerminalInstance,
  (prev, next) =>
    prev.paneId === next.paneId &&
    prev.ptyId === next.ptyId &&
    prev.worktreePath === next.worktreePath &&
    prev.tabId === next.tabId &&
    prev.label === next.label,
);
