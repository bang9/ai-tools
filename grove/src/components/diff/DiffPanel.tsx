import { useDiff } from "../../hooks/useDiff";
import { useResolvedSidebarSelection } from "../../hooks/useResolvedSidebarSelection";
import { useWorktreeBranchLabel } from "../../hooks/useWorktreeBranchLabel";
import { usePanelLayoutStore } from "../../store/panel-layout";
import type { FileStatus } from "../../types";
import { cn } from "../../lib/cn";
import ResizablePanelGroup from "../ui/resizable-panel-group";
import CommitList from "./CommitList";
import FileList from "./FileList";
import DiffViewer from "./DiffViewer";

export default function DiffPanel() {
  const { worktreePath } = useResolvedSidebarSelection();
  const branchName = useWorktreeBranchLabel(worktreePath);
  const store = useDiff(worktreePath);
  const diffSizes = usePanelLayoutStore((s) => s.diff);
  const updateDiff = usePanelLayoutStore((s) => s.updateDiff);
  const viewerDiffs = store.currentDiff ? [store.currentDiff] : [];
  if (store.selectedView !== "changes" && !store.currentDiff) {
    viewerDiffs.push(...store.commitDiffs);
  }
  const fileStatuses = store.selectedView === "changes"
    ? store.fileStatuses
    : store.commitDiffs.map((d) => ({
        path: d.path,
        status: d.status as FileStatus["status"],
        staged: false,
      }));

  if (!worktreePath) {
    return (
      <div className={cn("flex items-center justify-center h-full bg-sidebar")}>
        <span className={cn("text-sm text-muted-foreground")}>
          Select a worktree to view changes
        </span>
      </div>
    );
  }

  return (
    <ResizablePanelGroup
      className={cn("flex flex-col h-full overflow-hidden bg-sidebar")}
      vertical
      ratios={diffSizes}
      onCommit={updateDiff}
    >
      <ResizablePanelGroup.Pane minSize={80}>
        <CommitList
          commits={store.commits}
          changeCount={store.fileStatuses.length}
          selectedView={store.selectedView}
          onSelectView={store.selectView}
          behindCount={store.behindCount}
          branchName={branchName}
          merging={store.merging}
          onMerge={store.mergeDefaultBranch}
        />
      </ResizablePanelGroup.Pane>
      <ResizablePanelGroup.Pane minSize={60}>
        <FileList
          fileStatuses={fileStatuses}
          selectedFile={store.selectedFile}
          onSelectFile={store.selectFile}
        />
      </ResizablePanelGroup.Pane>
      <ResizablePanelGroup.Pane minSize={100}>
        <DiffViewer
          diffs={viewerDiffs}
          isStaged={false}
          isCommitView={store.selectedView !== "changes"}
          commitHash={store.selectedView === "changes" ? undefined : store.selectedView.hash}
        />
      </ResizablePanelGroup.Pane>
    </ResizablePanelGroup>
  );
}
