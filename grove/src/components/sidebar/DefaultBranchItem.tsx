import { useRef, useState } from "react";
import { ArrowLeftRight, GitBranch, Loader2, RotateCw } from "lucide-react";
import type { Project } from "../../types";
import { useProjectStore } from "../../store/project";
import { useToast } from "../../store/toast";
import { cn } from "../../lib/cn";
import { useSidebarLeafActivation } from "../../hooks/useSidebarLeafActivation";
import { AiStatusIcons } from "./WorktreeItem";
import SidebarLeafItem from "./SidebarLeafItem";
import { useAiWorktreeSessions, useWorktreeBell } from "./worktree-status";
import { BranchSelector } from "./BranchSelector";
import SidebarContextMenu from "./SidebarContextMenu";
import { getNoteKey, NoteEmoji } from "./NotePopover";

interface Props {
  project: Project;
}

function DefaultBranchItem({ project }: Props) {
  const [refreshing, setRefreshing] = useState(false);
  const [selectorOpen, setSelectorOpen] = useState(false);
  const switchBtnRef = useRef<HTMLButtonElement>(null);
  const isSelected = useProjectStore((s) => s.selectedWorktree?.path === project.sourcePath);
  const selectWorktree = useProjectStore((s) => s.selectWorktree);
  const refreshProject = useProjectStore((s) => s.refreshProject);
  const setBaseBranch = useProjectStore((s) => s.setBaseBranch);
  const { toast } = useToast();

  const displayBranch = project.baseBranch ?? project.resolvedDefaultBranch;
  const branchLabel = project.baseBranch ? "(base)" : "(base·default)";
  const sourceWorktree = {
    name: "source",
    path: project.sourcePath,
    branch: displayBranch,
  };
  const hasBell = useWorktreeBell(project.sourcePath);
  const aiSessions = useAiWorktreeSessions(project.sourcePath);
  const noteKey = getNoteKey({ type: "sot", projectId: project.id });
  const handleActivate = useSidebarLeafActivation({
    disabled: refreshing,
    isSelected,
    onSelect: () => selectWorktree(sourceWorktree),
  });

  const handleRefresh = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setRefreshing(true);
    try {
      await refreshProject(project.id);
      toast("success", `Project '${project.repo}' source synced`);
    } catch {
      // Toasts are handled by the command layer.
    } finally {
      setRefreshing(false);
    }
  };

  const handleSwitchClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectorOpen((prev) => !prev);
  };

  const handleBranchSelect = async (branch: string | null) => {
    setSelectorOpen(false);
    try {
      await setBaseBranch(project.id, branch);
      toast(
        "success",
        branch ? `Base branch set to '${branch}'` : "Base branch reset to auto-detect",
      );
    } catch {
      // Toasts are handled by the command layer.
    }
  };

  return (
    <div>
      <SidebarContextMenu path={project.sourcePath} noteKey={noteKey} noteLabel={project.repo}>
        <SidebarLeafItem
          icon={
            <GitBranch
              className={cn("h-[13px] w-[13px] shrink-0", {
                "text-orange-500": hasBell,
              })}
            />
          }
          label={
            <span className={cn("min-w-0 flex-1 truncate")}>
              {displayBranch}
              <span className={cn("ml-1 text-muted-foreground/60")}>{branchLabel}</span>
              <NoteEmoji noteKey={noteKey} label={project.repo} />
            </span>
          }
          title={project.sourcePath}
          isSelected={isSelected}
          disabled={refreshing}
          onActivate={handleActivate}
          status={<AiStatusIcons sessions={aiSessions} />}
          forceShowAction={project.sourceBehindRemote}
          action={
            refreshing ? (
              <Loader2 className={cn("h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground")} />
            ) : (
              <span className={cn("flex items-center gap-0.5")}>
                <button
                  ref={switchBtnRef}
                  className={cn(
                    "h-4 w-4 cursor-pointer flex items-center justify-center rounded-sm transition-colors hover:text-foreground",
                  )}
                  onClick={handleSwitchClick}
                  title="Change base branch"
                >
                  <ArrowLeftRight className={cn("h-3 w-3")} />
                </button>
                <button
                  className={cn(
                    "h-4 w-4 cursor-pointer flex items-center justify-center rounded-sm transition-colors hover:text-foreground",
                    {
                      "opacity-30 cursor-not-allowed": project.sourceHasChanges,
                      "text-accent": !project.sourceHasChanges && project.sourceBehindRemote,
                    },
                  )}
                  onClick={handleRefresh}
                  disabled={project.sourceHasChanges}
                  title={
                    project.sourceHasChanges
                      ? "Commit or stash working changes before syncing"
                      : "Sync source repo"
                  }
                >
                  <RotateCw className={cn("h-3 w-3")} />
                </button>
              </span>
            )
          }
        />
      </SidebarContextMenu>

      {selectorOpen && (
        <BranchSelector
          projectId={project.id}
          currentBranch={project.baseBranch}
          resolvedDefaultBranch={project.resolvedDefaultBranch}
          anchorRef={switchBtnRef}
          onSelect={handleBranchSelect}
          onClose={() => setSelectorOpen(false)}
        />
      )}
    </div>
  );
}

export default DefaultBranchItem;
