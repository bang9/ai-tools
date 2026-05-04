import { useCallback } from "react";
import { useDiff } from "../../hooks/useDiff";
import { useResolvedSidebarSelection } from "../../hooks/useResolvedSidebarSelection";
import { useWorktreeBranchLabel } from "../../hooks/useWorktreeBranchLabel";
import { useTabStore } from "../../store/tab";
import { cn } from "../../lib/cn";
import CommitList from "./CommitList";
import type { CommitInfo } from "../../types";

export default function CommitHistoryPanel() {
  const { worktreePath } = useResolvedSidebarSelection();
  const branchName = useWorktreeBranchLabel(worktreePath);
  const store = useDiff(worktreePath);
  const addTab = useTabStore((s) => s.addTab);

  const handleSelectView = useCallback(
    (view: "changes" | CommitInfo) => {
      store.selectView(view);
      addTab("changes", "Changes");
    },
    [store.selectView, addTab],
  );

  if (!worktreePath) {
    return (
      <div className={cn("flex items-center justify-center h-full bg-sidebar")}>
        <span className={cn("text-sm text-muted-foreground")}>
          Select a worktree
        </span>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col h-full overflow-hidden bg-sidebar")}>
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
    </div>
  );
}
