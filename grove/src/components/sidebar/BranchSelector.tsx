import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Loader2, Search } from "lucide-react";
import { cn } from "../../lib/cn";
import * as tauri from "../../lib/platform";
import { runCommand } from "../../lib/command";

interface Props {
  projectId: string;
  currentBranch: string | null;
  resolvedDefaultBranch: string;
  anchorRef: React.RefObject<HTMLElement | null>;
  onSelect: (branch: string | null) => void;
  onClose: () => void;
}

export function BranchSelector({
  projectId,
  currentBranch,
  resolvedDefaultBranch,
  anchorRef,
  onSelect,
  onClose,
}: Props) {
  const [branches, setBranches] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [position, setPosition] = useState<{ top: number; left: number }>({
    top: 0,
    left: 0,
  });
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    setPosition({ top: rect.bottom + 4, left: rect.left });
  }, [anchorRef]);

  useLayoutEffect(() => {
    updatePosition();
  }, [updatePosition]);

  useEffect(() => {
    window.addEventListener("resize", updatePosition);
    return () => window.removeEventListener("resize", updatePosition);
  }, [updatePosition]);

  const fetchBranches = useCallback(() => {
    setLoading(true);
    setError(null);
    runCommand(() => tauri.getRemoteBranches(projectId), {
      errorToast: false,
    })
      .then(setBranches)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load branches"))
      .finally(() => setLoading(false));
  }, [projectId]);

  useEffect(() => {
    fetchBranches();
  }, [fetchBranches]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [loading]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node) &&
        anchorRef.current &&
        !anchorRef.current.contains(e.target as Node)
      ) {
        onCloseRef.current();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const filtered = branches.filter(
    (b) => b !== resolvedDefaultBranch && b.toLowerCase().includes(search.toLowerCase()),
  );

  return createPortal(
    <div
      ref={containerRef}
      style={{ top: position.top, left: position.left }}
      className={cn("fixed z-50 w-64 rounded-md border border-border bg-popover shadow-lg")}
    >
      <div className={cn("flex items-center gap-2 border-b border-border px-2 py-1.5")}>
        <Search className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground")} />
        <input
          ref={inputRef}
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onCloseRef.current();
          }}
          placeholder="Search branches..."
          className={cn(
            "flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground",
          )}
        />
      </div>

      <div className={cn("max-h-48 overflow-y-auto py-1")}>
        {loading && (
          <div className={cn("flex items-center justify-center py-4")}>
            <Loader2 className={cn("h-4 w-4 animate-spin text-muted-foreground")} />
          </div>
        )}

        {error && (
          <div className={cn("px-3 py-2 text-xs text-destructive")}>
            {error}
            <button className={cn("ml-2 underline")} onClick={fetchBranches}>
              Retry
            </button>
          </div>
        )}

        {!loading && !error && (
          <button
            className={cn(
              "flex w-full cursor-pointer items-center gap-2 px-3 py-1 text-left text-xs transition-colors hover:bg-secondary/50 hover:text-foreground",
              { "text-foreground": currentBranch === null },
            )}
            onClick={() => onSelect(null)}
          >
            <Check
              className={cn("h-3 w-3 shrink-0", {
                "opacity-100": currentBranch === null,
                "opacity-0": currentBranch !== null,
              })}
            />
            <span className={cn("truncate")}>{resolvedDefaultBranch} (default)</span>
          </button>
        )}

        {!loading &&
          !error &&
          filtered.map((branch) => (
            <button
              key={branch}
              className={cn(
                "flex w-full cursor-pointer items-center gap-2 px-3 py-1 text-left text-xs transition-colors hover:bg-secondary/50 hover:text-foreground",
                { "text-foreground": branch === currentBranch },
              )}
              onClick={() => onSelect(branch)}
            >
              <Check
                className={cn("h-3 w-3 shrink-0", {
                  "opacity-100": branch === currentBranch,
                  "opacity-0": branch !== currentBranch,
                })}
              />
              <span className={cn("truncate")}>{branch}</span>
            </button>
          ))}

        {!loading && !error && filtered.length === 0 && (
          <div className={cn("px-3 py-2 text-xs text-muted-foreground")}>No branches found</div>
        )}
      </div>
    </div>,
    document.body,
  );
}
