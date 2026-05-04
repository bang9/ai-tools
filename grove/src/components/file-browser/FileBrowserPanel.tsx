import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { DirectoryFileEntry } from "../../types";
import { cn } from "../../lib/cn";
import { revealInFinder } from "../../lib/platform";
import { runCommandSafely } from "../../lib/command";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../ui/context-menu";

const FILE_BROWSER_ROW_HEIGHT = 24;
const ROOT_PARENT = "";

function joinRootPath(rootPath: string, entryPath: string): string {
  return `${rootPath.replace(/\/$/, "")}/${entryPath}`;
}

function getParentPath(path: string): string | null {
  const index = path.lastIndexOf("/");
  return index === -1 ? ROOT_PARENT : path.slice(0, index);
}

function collectVisibleEntries(
  entriesByParent: Record<string, DirectoryFileEntry[]>,
  expandedPaths: Set<string>,
): DirectoryFileEntry[] {
  const result: DirectoryFileEntry[] = [];
  const appendChildren = (parentPath: string) => {
    for (const entry of entriesByParent[parentPath] ?? []) {
      result.push(entry);
      if (entry.entryType === "directory" && expandedPaths.has(entry.path)) {
        appendChildren(entry.path);
      }
    }
  };
  appendChildren(ROOT_PARENT);
  return result;
}

interface Props {
  rootPath: string;
  entriesByParent: Record<string, DirectoryFileEntry[]>;
  loadingParents: Record<string, boolean>;
  loadChildren: (parentPath?: string | null) => Promise<void>;
}

export default function FileBrowserPanel({
  rootPath,
  entriesByParent,
  loadingParents,
  loadChildren,
}: Props) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const visibleEntries = useMemo(
    () => collectVisibleEntries(entriesByParent, expandedPaths),
    [entriesByParent, expandedPaths],
  );
  const rowVirtualizer = useVirtualizer({
    count: visibleEntries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => FILE_BROWSER_ROW_HEIGHT,
    overscan: 12,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const loading = Object.values(loadingParents).some(Boolean);

  useEffect(() => {
    setSelectedPath(null);
    setExpandedPaths(new Set());
  }, [rootPath]);

  useEffect(() => {
    if (selectedPath && !visibleEntries.some((entry) => entry.path === selectedPath)) {
      setSelectedPath(null);
    }
  }, [selectedPath, visibleEntries]);

  const revealEntry = useCallback(
    (entry: DirectoryFileEntry) => {
      void runCommandSafely(() => revealInFinder(joinRootPath(rootPath, entry.path)));
    },
    [rootPath],
  );

  const expandDirectory = useCallback(
    (path: string) => {
      setExpandedPaths((current) => {
        if (current.has(path)) return current;
        const next = new Set(current);
        next.add(path);
        return next;
      });
      void loadChildren(path);
    },
    [loadChildren],
  );

  const collapseDirectory = useCallback((path: string) => {
    setExpandedPaths((current) => {
      if (!current.has(path)) return current;
      const next = new Set(current);
      next.delete(path);
      return next;
    });
  }, []);

  const toggleDirectory = useCallback(
    (path: string) => {
      if (expandedPaths.has(path)) {
        collapseDirectory(path);
      } else {
        expandDirectory(path);
      }
    },
    [collapseDirectory, expandedPaths, expandDirectory],
  );

  const selectByIndex = useCallback(
    (index: number) => {
      const entry = visibleEntries[index];
      if (!entry) return;
      setSelectedPath(entry.path);
      rowVirtualizer.scrollToIndex(index, { align: "auto" });
    },
    [rowVirtualizer, visibleEntries],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (visibleEntries.length === 0) return;

      const currentIndex = selectedPath
        ? visibleEntries.findIndex((entry) => entry.path === selectedPath)
        : -1;
      const currentEntry = currentIndex >= 0 ? visibleEntries[currentIndex] : null;

      if (event.key === "ArrowDown") {
        event.preventDefault();
        selectByIndex(Math.min(currentIndex + 1, visibleEntries.length - 1));
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        selectByIndex(Math.max(currentIndex - 1, 0));
        return;
      }

      if (event.key === "Home") {
        event.preventDefault();
        selectByIndex(0);
        return;
      }

      if (event.key === "End") {
        event.preventDefault();
        selectByIndex(visibleEntries.length - 1);
        return;
      }

      if (!currentEntry) return;

      if (event.key === "ArrowRight" && currentEntry.entryType === "directory") {
        event.preventDefault();
        if (!expandedPaths.has(currentEntry.path)) {
          expandDirectory(currentEntry.path);
          return;
        }
        const firstChild = entriesByParent[currentEntry.path]?.[0];
        if (firstChild) {
          selectByIndex(visibleEntries.findIndex((entry) => entry.path === firstChild.path));
        }
        return;
      }

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        if (currentEntry.entryType === "directory" && expandedPaths.has(currentEntry.path)) {
          collapseDirectory(currentEntry.path);
          return;
        }
        const parentPath = getParentPath(currentEntry.path);
        if (parentPath !== null && parentPath !== ROOT_PARENT) {
          const parentIndex = visibleEntries.findIndex((entry) => entry.path === parentPath);
          if (parentIndex >= 0) selectByIndex(parentIndex);
        }
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        if (currentEntry.entryType === "directory") {
          toggleDirectory(currentEntry.path);
        } else {
          revealEntry(currentEntry);
        }
        return;
      }

      if (event.key === " " && currentEntry.entryType === "directory") {
        event.preventDefault();
        toggleDirectory(currentEntry.path);
      }
    },
    [
      collapseDirectory,
      entriesByParent,
      expandedPaths,
      expandDirectory,
      revealEntry,
      rowVirtualizer,
      selectByIndex,
      selectedPath,
      toggleDirectory,
      visibleEntries,
    ],
  );

  return (
    <div className={cn("flex h-full min-h-0 flex-col overflow-hidden")}>
      <div className={cn("flex h-9 shrink-0 items-center gap-2 border-b border-border px-4")}>
        <span className={cn("text-xs font-medium uppercase tracking-wider text-muted-foreground")}>
          File Browser
        </span>
        <span className={cn("rounded-full bg-accent/20 px-2 py-0.5 text-xs font-medium text-accent")}>
          {visibleEntries.length}
        </span>
        {loading && (
          <Loader2 className={cn("ml-auto size-3.5 shrink-0 animate-spin text-muted-foreground")} />
        )}
      </div>
      {visibleEntries.length === 0 ? (
        <div className={cn("flex flex-1 items-center justify-center text-sm text-muted-foreground")}>
          {loading ? "Loading files" : "No files"}
        </div>
      ) : (
        <div
          ref={scrollRef}
          className={cn("relative flex-1 overflow-y-auto outline-none")}
          tabIndex={0}
          onKeyDown={handleKeyDown}
        >
          <div
            className={cn("relative w-full")}
            style={{ height: rowVirtualizer.getTotalSize() }}
          >
            {virtualRows.map((virtualRow) => {
              const entry = visibleEntries[virtualRow.index];
              const isFile = entry.entryType === "file";
              const selected = selectedPath === entry.path;
              const expanded = !isFile && expandedPaths.has(entry.path);
              const directoryLoading = !!loadingParents[entry.path];
              const Icon = isFile ? FileText : Folder;
              const ToggleIcon = expanded ? ChevronDown : ChevronRight;
              let disclosureIcon = <span className={cn("size-3.5 shrink-0")} />;
              if (!isFile && directoryLoading) {
                disclosureIcon = (
                  <Loader2 className={cn("size-3.5 shrink-0 animate-spin text-muted-foreground")} />
                );
              } else if (!isFile) {
                disclosureIcon = (
                  <ToggleIcon className={cn("size-3.5 shrink-0 text-muted-foreground")} />
                );
              }

              return (
                <div
                  key={`${entry.entryType}:${entry.path}`}
                  className={cn("absolute left-0 top-0 w-full")}
                  style={{
                    height: virtualRow.size,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <ContextMenu>
                    <ContextMenuTrigger asChild>
                      <button
                        type="button"
                        title={entry.path}
                        className={cn(
                          "flex h-6 w-full items-center gap-2 pr-3 text-left text-sm transition-colors",
                          {
                            "bg-selected text-foreground": selected,
                            "text-muted-foreground hover:bg-secondary/30 hover:text-foreground":
                              !selected,
                          },
                        )}
                        style={{ paddingLeft: 16 + entry.depth * 14 }}
                        onClick={() => setSelectedPath(entry.path)}
                        onDoubleClick={() => {
                          if (isFile) {
                            revealEntry(entry);
                          } else {
                            toggleDirectory(entry.path);
                          }
                        }}
                        aria-expanded={isFile ? undefined : expanded}
                      >
                        {disclosureIcon}
                        <Icon
                          className={cn("size-3.5 shrink-0", {
                            "text-accent": !isFile,
                          })}
                        />
                        <span className={cn("min-w-0 flex-1 truncate", {
                          "font-medium": selected,
                        })}>
                          {entry.name}
                        </span>
                      </button>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem onSelect={() => revealEntry(entry)}>
                        <FolderOpen className={cn("mr-1.5 size-3.5")} />
                        Open in Finder
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
