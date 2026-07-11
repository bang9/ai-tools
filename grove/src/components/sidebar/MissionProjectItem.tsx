import { FolderGit2, Loader2, X } from "lucide-react";
import type { MissionProject } from "../../types";
import { useMissionStore } from "../../store/mission";
import { useProjectStore } from "../../store/project";
import { useTerminalStore } from "../../store/terminal";
import { cn } from "../../lib/cn";
import { overlay } from "../../lib/overlay";
import { useSidebarLeafActivation } from "../../hooks/useSidebarLeafActivation";
import SidebarLeafItem from "./SidebarLeafItem";
import SidebarContextMenu from "./SidebarContextMenu";
import { AiStatusIcons } from "./WorktreeItem";
import { useAiWorktreeSessions, useWorktreeBell } from "./worktree-status";

interface Props {
  missionId: string;
  project: MissionProject;
}

function MissionProjectItem({ missionId, project }: Props) {
  const selectedItem = useMissionStore((s) => s.selectedItem);
  const selectItem = useMissionStore((s) => s.selectItem);
  const removeProject = useMissionStore((s) => s.removeProject);
  const deletingMission = useMissionStore((s) => !!s.deletingMissions[missionId]);
  const deletingProject = useMissionStore(
    (s) => !!s.deletingMissionProjects[`${missionId}:${project.projectId}`],
  );
  const projects = useProjectStore((s) => s.projects);

  const isSelected =
    selectedItem?.missionId === missionId && selectedItem?.projectId === project.projectId;

  const projectData = projects.find((p) => p.id === project.projectId);
  const projectLabel =
    projectData && projectData.name !== projectData.repo
      ? projectData.name
      : projectData && `${projectData.org}/${projectData.repo}`;
  const displayName = projectLabel ?? project.branch;
  const disabled = deletingMission || deletingProject;
  const hasBell = useWorktreeBell(project.path);
  const aiSessions = useAiWorktreeSessions(project.path);
  const handleActivate = useSidebarLeafActivation({
    disabled,
    isSelected,
    onSelect: () => {
      selectItem(missionId, project.projectId);
      useTerminalStore.getState().setActiveWorktree(project.path);
    },
  });

  const handleRemove = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (disabled) return;
    const confirmed = await overlay.confirm({
      title: "Remove project from mission?",
      description: `Remove "${displayName}" from this mission?`,
      confirmLabel: "Remove",
      variant: "destructive",
    });
    if (!confirmed) return;
    await removeProject(missionId, project.projectId);
  };

  return (
    <SidebarContextMenu path={project.path}>
      <SidebarLeafItem
        icon={
          <FolderGit2
            className={cn("h-[13px] w-[13px] shrink-0", {
              "text-orange-500": hasBell,
            })}
          />
        }
        label={displayName}
        title={project.path}
        isSelected={isSelected}
        disabled={disabled}
        onActivate={handleActivate}
        status={<AiStatusIcons sessions={aiSessions} />}
        action={
          deletingProject ? (
            <Loader2 className={cn("h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground")} />
          ) : (
            <button
              className={cn(
                "h-4 w-4 cursor-pointer items-center justify-center rounded-sm transition-colors",
                {
                  "flex opacity-50 hover:opacity-100 hover:text-foreground": isSelected,
                  "hidden group-hover:flex hover:text-foreground": !isSelected,
                },
              )}
              onClick={handleRemove}
              title="Remove from mission"
            >
              <X className={cn("h-3 w-3")} />
            </button>
          )
        }
      />
    </SidebarContextMenu>
  );
}

export default MissionProjectItem;
