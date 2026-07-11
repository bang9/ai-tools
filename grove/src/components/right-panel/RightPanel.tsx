import { useCallback, useEffect, useState } from "react";
import { FolderTree, GitCommit } from "lucide-react";
import { useDiff } from "../../hooks/useDiff";
import { useResolvedSidebarSelection } from "../../hooks/useResolvedSidebarSelection";
import { useWorktreeBranchLabel } from "../../hooks/useWorktreeBranchLabel";
import { useFileBrowserStore } from "../../store/file-browser";
import { useTabStore } from "../../store/tab";
import { cn } from "../../lib/cn";
import CommitList from "../diff/CommitList";
import type { CommitInfo } from "../../types";
import FileBrowserPanel from "../file-browser/FileBrowserPanel";

type RightPanelMode = "commits" | "file-browser";

function RailButton({
  active,
  disabled,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  icon: typeof GitCommit;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      className={cn("flex size-8 items-center justify-center rounded-md border transition-colors", {
        "border-accent/30 bg-accent/15 text-accent": active,
        "border-transparent text-muted-foreground hover:bg-secondary/50 hover:text-foreground":
          !active,
      })}
      onClick={onClick}
    >
      <Icon className={cn("size-4")} />
    </button>
  );
}

export default function RightPanel() {
  const { terminalPath, worktreePath } = useResolvedSidebarSelection();
  const branchName = useWorktreeBranchLabel(worktreePath);
  const store = useDiff(worktreePath);
  const fileBrowserEntriesByParent = useFileBrowserStore((s) => s.entriesByParent);
  const fileBrowserLoadingParents = useFileBrowserStore((s) => s.loadingParents);
  const setFileBrowserRootPath = useFileBrowserStore((s) => s.setRootPath);
  const loadFileBrowserChildren = useFileBrowserStore((s) => s.loadChildren);
  const addTab = useTabStore((s) => s.addTab);
  const [mode, setMode] = useState<RightPanelMode>("commits");
  const fileBrowserRootPath = worktreePath ?? terminalPath;

  const handleSelectView = useCallback(
    (view: "changes" | CommitInfo) => {
      store.selectView(view);
      addTab("changes", "Changes");
    },
    [store.selectView, addTab],
  );

  useEffect(() => {
    setFileBrowserRootPath(fileBrowserRootPath);
    if (mode === "file-browser" && fileBrowserRootPath) {
      void loadFileBrowserChildren("");
    }
  }, [fileBrowserRootPath, loadFileBrowserChildren, mode, setFileBrowserRootPath]);

  const content = (() => {
    if (mode === "file-browser") {
      if (!fileBrowserRootPath) {
        return (
          <div className={cn("flex h-full items-center justify-center bg-sidebar")}>
            <span className={cn("text-sm text-muted-foreground")}>
              Select a mission or worktree
            </span>
          </div>
        );
      }

      return (
        <FileBrowserPanel
          rootPath={fileBrowserRootPath}
          entriesByParent={fileBrowserEntriesByParent}
          loadingParents={fileBrowserLoadingParents}
          loadChildren={loadFileBrowserChildren}
        />
      );
    }

    if (!worktreePath) {
      return (
        <div className={cn("flex h-full items-center justify-center bg-sidebar")}>
          <span className={cn("text-sm text-muted-foreground")}>Select a worktree</span>
        </div>
      );
    }

    return (
      <CommitList
        commits={store.commits}
        changeCount={store.fileStatuses.length}
        selectedView={store.selectedView}
        onSelectView={handleSelectView}
        behindCount={store.behindCount}
        branchName={branchName}
        merging={store.merging}
        onMerge={store.mergeDefaultBranch}
      />
    );
  })();

  return (
    <div className={cn("flex h-full overflow-hidden bg-sidebar")}>
      <div className={cn("min-w-0 flex-1 overflow-hidden")}>{content}</div>
      <div
        className={cn(
          "flex w-10 shrink-0 flex-col items-center gap-1 border-l border-border bg-sidebar/90 py-2",
        )}
      >
        <RailButton
          active={mode === "commits"}
          icon={GitCommit}
          label="Commits"
          onClick={() => setMode("commits")}
        />
        <RailButton
          active={mode === "file-browser"}
          disabled={!fileBrowserRootPath}
          icon={FolderTree}
          label="File browser"
          onClick={() => setMode("file-browser")}
        />
      </div>
    </div>
  );
}
