import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useDiffStore } from "../../store/diff";
import { useDiff } from "../../hooks/useDiff";
import { useResolvedSidebarSelection } from "../../hooks/useResolvedSidebarSelection";
import { usePanelLayoutStore } from "../../store/panel-layout";
import { cn } from "../../lib/cn";
import { runCommandSafely } from "../../lib/command";
import * as tauri from "../../lib/platform";
import { overlay } from "../../lib/overlay";
import ResizablePanelGroup from "../ui/resizable-panel-group";
import {
  filterDiffsBySelectedPaths,
  firstSelectedFilePath,
  selectFilePathRange,
} from "../../lib/diff-file-selection";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../ui/context-menu";
import DiffViewer from "../diff/DiffViewer";
import type { FileStatus, FileDiff } from "../../types";
import { FileText, Plus, Minus, Trash2, Undo2 } from "lucide-react";
import { useMarqueeSelection } from "../../hooks/useMarqueeSelection";

// ── FileItem ──

function FileItem({
  file,
  selected,
  onClick,
  actions,
}: {
  file: FileStatus;
  selected: boolean;
  onClick: (e: React.MouseEvent) => void;
  actions?: React.ReactNode;
}) {
  const statusColors: Record<string, string> = {
    modified: "text-yellow-400",
    added: "text-green-400",
    deleted: "text-red-400",
    renamed: "text-blue-400",
    untracked: "text-green-400",
  };

  return (
    <div
      data-file-item
      className={cn(
        "group flex items-center gap-1.5 w-full px-2 py-0.5 text-xs transition-colors cursor-pointer select-none",
        {
          "text-foreground": selected,
          "text-muted-foreground hover:bg-muted": !selected,
        },
      )}
      style={selected ? {
        background: "rgba(99, 163, 255, 0.08)",
        borderLeft: "2px solid rgba(99, 163, 255, 0.5)",
      } : { borderLeft: "2px solid transparent" }}
      onClick={onClick}
    >
      <FileText className={cn("size-3 shrink-0", statusColors[file.status])} />
      <span className={cn("truncate flex-1")}>{file.path}</span>
      {actions && (
        <div className={cn("flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100")}>
          {actions}
        </div>
      )}
      <span
        className={cn(
          "shrink-0 text-[10px] uppercase font-medium",
          statusColors[file.status],
        )}
      >
        {file.status[0]}
      </span>
    </div>
  );
}

// ── ActionButton ──

function ActionButton({
  icon: Icon,
  title,
  onClick,
  confirm: confirmMsg,
}: {
  icon: typeof Plus;
  title: string;
  onClick: () => void;
  confirm?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={async (e) => {
        e.stopPropagation();
        if (confirmMsg) {
          const confirmed = await overlay.confirm({
            title,
            description: confirmMsg,
            confirmLabel: title,
            variant: "destructive",
          });
          if (!confirmed) return;
        }
        onClick();
      }}
      className={cn(
        "flex items-center justify-center size-4 rounded-sm hover:bg-foreground/10 transition-colors",
      )}
    >
      <Icon className={cn("size-3")} />
    </button>
  );
}

// ── FileSection ──

function FileSection({
  title,
  files,
  selectedPaths,
  onSelectFile,
  onMarqueeSelect,
  onContextMenuFile,
  contextMenuContent,
  renderActions,
}: {
  title: string;
  files: FileStatus[];
  selectedPaths: Set<string>;
  onSelectFile: (path: string, shiftKey: boolean) => void;
  onMarqueeSelect?: (ids: Set<string>) => void;
  onContextMenuFile?: (path: string) => void;
  contextMenuContent?: React.ReactNode;
  renderActions?: (file: FileStatus) => React.ReactNode;
}) {
  const sectionRef = useRef<HTMLDivElement>(null);
  const itemRefsMap = useRef<Map<string, HTMLElement>>(new Map());
  const noop = useCallback(() => {}, []);
  const marquee = useMarqueeSelection(sectionRef, itemRefsMap, onMarqueeSelect ?? noop);

  return (
    <div className={cn("flex flex-col min-h-0 flex-1")}>
      <div
        className={cn(
          "flex items-center gap-2 px-2 h-7 shrink-0 border-b border-border select-none",
        )}
      >
        <span
          className={cn(
            "text-[10px] font-semibold uppercase tracking-wider text-muted-foreground",
          )}
        >
          {title}
        </span>
        <span
          className={cn(
            "rounded-full bg-accent/20 px-1.5 py-0.5 text-[10px] font-medium text-accent",
          )}
        >
          {selectedPaths.size > 0 ? `${selectedPaths.size}/${files.length}` : files.length}
        </span>
      </div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={sectionRef}
            className={cn("flex-1 min-h-0 overflow-y-auto relative select-none cursor-default")}
            {...marquee.handlers}
          >
            {files.map((file) => (
              <div
                key={file.path}
                ref={(el) => {
                  if (el) itemRefsMap.current.set(file.path, el);
                  else itemRefsMap.current.delete(file.path);
                }}
                onContextMenu={() => onContextMenuFile?.(file.path)}
              >
                <FileItem
                  file={file}
                  selected={selectedPaths.has(file.path)}
                  onClick={(e) => onSelectFile(file.path, e.shiftKey)}
                  actions={renderActions?.(file)}
                />
              </div>
            ))}
            {marquee.rect && (
              <div
                className={cn("absolute pointer-events-none z-10")}
                style={{
                  left: marquee.rect.x,
                  top: marquee.rect.y,
                  width: marquee.rect.width,
                  height: marquee.rect.height,
                  border: "1px solid rgba(99, 163, 255, 0.5)",
                  background: "rgba(99, 163, 255, 0.06)",
                  borderRadius: 2,
                }}
              />
            )}
          </div>
        </ContextMenuTrigger>
        {contextMenuContent && (
          <ContextMenuContent>{contextMenuContent}</ContextMenuContent>
        )}
      </ContextMenu>
    </div>
  );
}

// ── WorkingChangesView ──

function WorkingChangesView({
  store,
  ratios,
  onCommit,
}: {
  store: ReturnType<typeof useDiff>;
  ratios: number[];
  onCommit: (ratios: number[]) => void;
}) {
  const staged = store.fileStatuses.filter((f) => f.staged);
  const unstaged = store.fileStatuses.filter((f) => !f.staged);

  // Local selection state
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [selectedSection, setSelectedSection] = useState<"staged" | "unstaged">("unstaged");
  const lastClickedRef = useRef<{ section: "staged" | "unstaged"; path: string } | null>(null);

  // Multi-file diffs loaded at component level
  const [diffs, setDiffs] = useState<FileDiff[]>([]);
  const worktreePath = store.worktreePath;
  const clearLineSelection = useDiffStore((s) => s.clearSelection);

  // Load diffs for selected files — also re-fires when fileStatuses change (after mutations)
  const fileStatuses = store.fileStatuses;
  useEffect(() => {
    if (selectedPaths.size === 0 || !worktreePath) {
      setDiffs([]);
      return;
    }

    let cancelled = false;
    const isStaged = selectedSection === "staged";
    const paths = [...selectedPaths];

    Promise.all(
      paths.map((path) => {
        const queryPath = isStaged ? `staged:${path}` : path;
        return runCommandSafely(() => tauri.getWorkingDiff(worktreePath, queryPath), {
          errorToast: false,
        });
      }),
    ).then((results) => {
      if (cancelled) return;
      setDiffs(results.filter((d): d is FileDiff => d !== null));
    });

    return () => { cancelled = true; };
  }, [selectedPaths, selectedSection, worktreePath, fileStatuses]);

  // Clear line selection when file selection or section changes
  useEffect(() => {
    clearLineSelection();
  }, [selectedPaths, selectedSection, clearLineSelection]);

  // Selection handler
  const handleSelectFile = useCallback(
    (section: "staged" | "unstaged", files: FileStatus[], path: string, shiftKey: boolean) => {
      if (shiftKey && lastClickedRef.current?.section === section) {
        const lastPath = lastClickedRef.current.path;
        const lastIdx = files.findIndex((f) => f.path === lastPath);
        const curIdx = files.findIndex((f) => f.path === path);
        if (lastIdx >= 0 && curIdx >= 0) {
          const min = Math.min(lastIdx, curIdx);
          const max = Math.max(lastIdx, curIdx);
          const next = new Set<string>();
          for (let i = min; i <= max; i++) {
            next.add(files[i].path);
          }
          setSelectedPaths(next);
          setSelectedSection(section);
          return;
        }
      }
      setSelectedPaths(new Set([path]));
      setSelectedSection(section);
      lastClickedRef.current = { section, path };
    },
    [],
  );

  const isStaged = selectedSection === "staged";
  const allUntracked = useMemo(
    () => selectedSection === "unstaged"
      && selectedPaths.size > 0
      && [...selectedPaths].every((path) => unstaged.find((f) => f.path === path)?.status === "untracked"),
    [selectedSection, selectedPaths, unstaged],
  );

  const handleMarqueeSelect = useCallback(
    (section: "staged" | "unstaged", ids: Set<string>) => {
      setSelectedPaths(ids);
      setSelectedSection(section);
    },
    [],
  );

  // Keyboard
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === " " && selectedPaths.size > 0) {
        e.preventDefault();
        const paths = [...selectedPaths];
        setSelectedPaths(new Set());
        void (async () => {
          if (isStaged) {
            await store.unstageFiles(paths);
            return;
          }
          await store.stageFiles(paths);
        })();
      }
      if (e.key === "Escape") {
        setSelectedPaths(new Set());
      }
    },
    [selectedPaths, isStaged, store],
  );

  const fileListRef = useRef<HTMLDivElement>(null);

  // Auto-focus file list when selection changes so keyboard shortcuts work
  useEffect(() => {
    if (selectedPaths.size > 0) {
      fileListRef.current?.focus();
    }
  }, [selectedPaths]);

  const runDestructiveAction = useCallback(
    async (title: string, description: string, confirmLabel: string, action: (paths: string[]) => Promise<void>) => {
      const paths = [...selectedPaths];
      const confirmed = await overlay.confirm({ title, description, confirmLabel, variant: "destructive" });
      if (!confirmed) return;
      setSelectedPaths(new Set());
      await action(paths);
    },
    [selectedPaths],
  );

  const handleContextMenuFile = useCallback((section: "staged" | "unstaged", path: string) => {
    if (selectedSection === section && selectedPaths.has(path)) {
      return;
    }
    setSelectedPaths(new Set([path]));
    setSelectedSection(section);
    lastClickedRef.current = { section, path };
  }, [selectedPaths, selectedSection]);

  return (
    <ResizablePanelGroup className={cn("h-full")} ratios={ratios} onCommit={onCommit}>
      <ResizablePanelGroup.Pane minSize={160}>
        <div
          ref={fileListRef}
          className={cn("flex flex-col h-full bg-sidebar overflow-hidden outline-none")}
          tabIndex={0}
          onKeyDown={handleKeyDown}
        >
          <div className={cn("flex-1 flex flex-col min-h-0")}>
            <FileSection
              title="Staged"
              files={staged}
              selectedPaths={selectedSection === "staged" ? selectedPaths : new Set()}
              onSelectFile={(path, shiftKey) => handleSelectFile("staged", staged, path, shiftKey)}
              onMarqueeSelect={(ids) => handleMarqueeSelect("staged", ids)}
              onContextMenuFile={(path) => handleContextMenuFile("staged", path)}
              contextMenuContent={selectedSection === "staged" && selectedPaths.size > 0
                ? (
                    <ContextMenuItem
                      onSelect={async () => {
                        const paths = [...selectedPaths];
                        setSelectedPaths(new Set());
                        await store.unstageFiles(paths);
                      }}
                    >
                      Unstage
                    </ContextMenuItem>
                  )
                : undefined}
              renderActions={(file) => (
                <ActionButton icon={Minus} title="Unstage" onClick={() => store.unstageFile(file.path)} />
              )}
            />
          </div>
          <div className={cn("flex-1 flex flex-col min-h-0 border-t border-border")}>
            <FileSection
              title="Unstaged"
              files={unstaged}
              selectedPaths={selectedSection === "unstaged" ? selectedPaths : new Set()}
              onSelectFile={(path, shiftKey) => handleSelectFile("unstaged", unstaged, path, shiftKey)}
              onMarqueeSelect={(ids) => handleMarqueeSelect("unstaged", ids)}
              onContextMenuFile={(path) => handleContextMenuFile("unstaged", path)}
              contextMenuContent={selectedSection === "unstaged" && selectedPaths.size > 0
                ? (
                    <>
                      <ContextMenuItem
                        onSelect={async () => {
                          const paths = [...selectedPaths];
                          setSelectedPaths(new Set());
                          await store.stageFiles(paths);
                        }}
                      >
                        Stage
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        className={cn("text-destructive focus:text-destructive")}
                        onSelect={() => runDestructiveAction(
                          "Discard Changes",
                          `Discard changes to ${selectedPaths.size} file${selectedPaths.size > 1 ? "s" : ""}?`,
                          "Discard",
                          store.discardFiles,
                        )}
                      >
                        Discard
                      </ContextMenuItem>
                      {allUntracked && (
                        <ContextMenuItem
                          className={cn("text-destructive focus:text-destructive")}
                          onSelect={() => runDestructiveAction(
                            "Remove Files",
                            `Remove ${selectedPaths.size} untracked file${selectedPaths.size > 1 ? "s" : ""}?`,
                            "Remove",
                            store.removeUntrackedFiles,
                          )}
                        >
                          Remove
                        </ContextMenuItem>
                      )}
                    </>
                  )
                : undefined}
              renderActions={(file) => {
                const isUntracked = file.status === "untracked";
                const discardConfirm = isUntracked
                  ? "Remove this untracked file from the worktree?"
                  : "Discard all changes to this file?";

                return (
                  <>
                    <ActionButton icon={Plus} title="Stage" onClick={() => store.stageFile(file.path)} />
                    <ActionButton
                      icon={Undo2}
                      title="Discard"
                      onClick={() => store.discardFile(file.path)}
                      confirm={discardConfirm}
                    />
                    {isUntracked && (
                      <ActionButton
                        icon={Trash2}
                        title="Remove"
                        onClick={() => store.discardFile(file.path)}
                        confirm="Remove this untracked file from the worktree?"
                      />
                    )}
                  </>
                );
              }}
            />
          </div>
        </div>
      </ResizablePanelGroup.Pane>
      <ResizablePanelGroup.Pane minSize={200}>
        <DiffViewer diffs={diffs} isStaged={isStaged} />
      </ResizablePanelGroup.Pane>
    </ResizablePanelGroup>
  );
}

// ── CommitChangesView ──

function CommitChangesView({
  store,
  ratios,
  onCommit,
}: {
  store: ReturnType<typeof useDiff>;
  ratios: number[];
  onCommit: (ratios: number[]) => void;
}) {
  const files: FileStatus[] = useMemo(
    () => store.commitDiffs.map((d) => ({
      path: d.path,
      status: d.status as FileStatus["status"],
      staged: false,
    })),
    [store.commitDiffs],
  );

  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const lastClickedRef = useRef<string | null>(null);

  useEffect(() => {
    const initialPath = store.commitDiffs[0]?.path ?? null;
    setSelectedPaths(initialPath ? new Set([initialPath]) : new Set());
    lastClickedRef.current = initialPath;
  }, [store.commitDiffs]);

  const selectCommitFiles = useCallback(
    (next: Set<string>) => {
      setSelectedPaths(next);
      const firstPath = firstSelectedFilePath(files, next);
      store.selectFile(firstPath);
    },
    [files, store],
  );

  const handleMarqueeSelect = useCallback(
    (next: Set<string>) => {
      setSelectedPaths(next);
      lastClickedRef.current = firstSelectedFilePath(files, next);
    },
    [files],
  );

  const selectedDiffs = useMemo(
    () => filterDiffsBySelectedPaths(store.commitDiffs, selectedPaths),
    [store.commitDiffs, selectedPaths],
  );

  return (
    <ResizablePanelGroup className={cn("h-full")} ratios={ratios} onCommit={onCommit}>
      <ResizablePanelGroup.Pane minSize={160}>
        <div className={cn("flex flex-col h-full bg-sidebar overflow-hidden")}>
          <FileSection
            title="Files"
            files={files}
            selectedPaths={selectedPaths}
            onSelectFile={(path, shiftKey) => {
              if (shiftKey) {
                const range = selectFilePathRange(files, lastClickedRef.current, path);
                if (range) {
                  selectCommitFiles(range);
                  return;
                }
              }
              lastClickedRef.current = path;
              selectCommitFiles(new Set([path]));
            }}
            onMarqueeSelect={handleMarqueeSelect}
          />
        </div>
      </ResizablePanelGroup.Pane>
      <ResizablePanelGroup.Pane minSize={200}>
        <DiffViewer
          diffs={selectedDiffs}
          isStaged={false}
          isCommitView
          commitHash={store.selectedView === "changes" ? undefined : store.selectedView.hash}
        />
      </ResizablePanelGroup.Pane>
    </ResizablePanelGroup>
  );
}

// ── ChangesPanel ──

export default function ChangesPanel() {
  const { worktreePath } = useResolvedSidebarSelection();
  const store = useDiff(worktreePath);

  if (!worktreePath) {
    return (
      <div
        className={cn(
          "flex items-center justify-center h-full text-sm text-muted-foreground",
        )}
      >
        Select a worktree to view changes
      </div>
    );
  }

  const changesSizes = usePanelLayoutStore((s) => s.changes);
  const updateChanges = usePanelLayoutStore((s) => s.updateChanges);

  if (store.selectedView === "changes") {
    return <WorkingChangesView store={store} ratios={changesSizes} onCommit={updateChanges} />;
  }

  return <CommitChangesView store={store} ratios={changesSizes} onCommit={updateChanges} />;
}
