import { useCallback, useEffect, useState } from "react";
import { FolderTree, GitCommit, ListChecks } from "lucide-react";
import { useDiff } from "../../hooks/useDiff";
import { useResolvedSidebarSelection } from "../../hooks/useResolvedSidebarSelection";
import { useWorktreeBranchLabel } from "../../hooks/useWorktreeBranchLabel";
import { useTabStore } from "../../store/tab";
import { cn } from "../../lib/cn";
import CommitList from "./CommitList";
import type { CommitInfo } from "../../types";
import DirectoryFileList from "./DirectoryFileList";
import FileList from "./FileList";

type RightPanelMode = "commits" | "changes" | "directory";

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
      className={cn(
        "flex size-8 items-center justify-center rounded-md border transition-colors",
        {
          "border-accent/30 bg-accent/15 text-accent": active,
          "border-transparent text-muted-foreground hover:bg-secondary/50 hover:text-foreground":
            !active,
        },
      )}
      onClick={onClick}
    >
      <Icon className={cn("size-4")} />
    </button>
  );
}

export default function CommitHistoryPanel() {
  const { worktreePath } = useResolvedSidebarSelection();
  const branchName = useWorktreeBranchLabel(worktreePath);
  const store = useDiff(worktreePath);
  const addTab = useTabStore((s) => s.addTab);
  const [mode, setMode] = useState<RightPanelMode>("commits");

  const handleSelectView = useCallback(
    (view: "changes" | CommitInfo) => {
      store.selectView(view);
      addTab("changes", "Changes");
    },
    [store.selectView, addTab],
  );

  useEffect(() => {
    if (mode === "directory") {
      void store.loadDirectoryFiles();
    }
  }, [mode, worktreePath]);

  const handleSelectWorkingFile = useCallback(
    (path: string | null, staged?: boolean) => {
      store.selectView("changes");
      addTab("changes", "Changes");
      store.selectFile(path, staged);
    },
    [store.selectView, store.selectFile, addTab],
  );

  const content = (() => {
    if (!worktreePath) {
      return (
        <div className={cn("flex h-full items-center justify-center bg-sidebar")}>
          <span className={cn("text-sm text-muted-foreground")}>
            Select a worktree
          </span>
        </div>
      );
    }

    if (mode === "changes") {
      return (
        <FileList
          fileStatuses={store.fileStatuses}
          selectedFile={store.selectedFile}
          onSelectFile={handleSelectWorkingFile}
          title="Working Changes"
        />
      );
    }

    if (mode === "directory") {
      return (
        <DirectoryFileList
          entries={store.directoryFiles}
          loading={store.directoryFilesLoading}
          selectedFile={store.selectedFile}
          onSelectFile={(path) => handleSelectWorkingFile(path)}
        />
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
      <div className={cn("min-w-0 flex-1 overflow-hidden")}>
        {content}
      </div>
      <div className={cn("flex w-10 shrink-0 flex-col items-center gap-1 border-l border-border bg-sidebar/90 py-2")}>
        <RailButton
          active={mode === "commits"}
          icon={GitCommit}
          label="Commits"
          onClick={() => setMode("commits")}
        />
        <RailButton
          active={mode === "changes"}
          disabled={!worktreePath}
          icon={ListChecks}
          label="Working changes"
          onClick={() => setMode("changes")}
        />
        <RailButton
          active={mode === "directory"}
          disabled={!worktreePath}
          icon={FolderTree}
          label="Directory & files"
          onClick={() => setMode("directory")}
        />
      </div>
    </div>
  );
}
