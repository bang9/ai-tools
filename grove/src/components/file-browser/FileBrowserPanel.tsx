import { useVirtualizer } from "@tanstack/react-virtual";
import { FileText, Folder, FolderOpen, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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

function joinWorktreePath(worktreePath: string, entryPath: string): string {
  return `${worktreePath.replace(/\/$/, "")}/${entryPath}`;
}

interface Props {
  worktreePath: string;
  entries: DirectoryFileEntry[];
  loading: boolean;
}

export default function FileBrowserPanel({
  worktreePath,
  entries,
  loading,
}: Props) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => FILE_BROWSER_ROW_HEIGHT,
    overscan: 12,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();

  useEffect(() => {
    setSelectedPath(null);
  }, [worktreePath]);

  const revealEntry = (entry: DirectoryFileEntry) => {
    void runCommandSafely(() => revealInFinder(joinWorktreePath(worktreePath, entry.path)));
  };

  return (
    <div className={cn("flex h-full min-h-0 flex-col overflow-hidden")}>
      <div className={cn("flex h-9 shrink-0 items-center gap-2 border-b border-border px-4")}>
        <span className={cn("text-xs font-medium uppercase tracking-wider text-muted-foreground")}>
          Directory & Files
        </span>
        <span className={cn("rounded-full bg-accent/20 px-2 py-0.5 text-xs font-medium text-accent")}>
          {entries.length}
        </span>
        {loading && (
          <Loader2 className={cn("ml-auto size-3.5 shrink-0 animate-spin text-muted-foreground")} />
        )}
      </div>
      {entries.length === 0 ? (
        <div className={cn("flex flex-1 items-center justify-center text-sm text-muted-foreground")}>
          {loading ? "Loading files" : "No files"}
        </div>
      ) : (
        <div ref={scrollRef} className={cn("relative flex-1 overflow-y-auto")}>
          <div
            className={cn("relative w-full")}
            style={{ height: rowVirtualizer.getTotalSize() }}
          >
            {virtualRows.map((virtualRow) => {
              const entry = entries[virtualRow.index];
              const isFile = entry.entryType === "file";
              const selected = selectedPath === entry.path;
              const Icon = isFile ? FileText : Folder;

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
                        onDoubleClick={() => revealEntry(entry)}
                      >
                        <Icon className={cn("size-3.5 shrink-0", {
                          "text-accent": !isFile,
                        })} />
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
