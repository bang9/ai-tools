import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Plus,
  X,
  Loader2,
} from "lucide-react";
import type { Mission } from "../../types";
import { useMissionStore } from "../../store/mission";
import { useTerminalStore } from "../../store/terminal";
import { IconButton } from "../ui/button";
import { Badge } from "../ui/badge";
import MissionProjectItem from "./MissionProjectItem";
import AddProjectToMissionDialog from "./AddProjectToMissionDialog";
import { cn } from "../../lib/cn";
import { overlay } from "../../lib/overlay";
import SidebarContextMenu from "./SidebarContextMenu";
import { getNoteKey, NoteEmoji } from "./NotePopover";
import { AiStatusIcons } from "./WorktreeItem";
import { useAiWorktreeSessions } from "./worktree-status";

interface Props {
  mission: Mission;
}

function MissionItem({ mission }: Props) {
  const collapsed = mission.collapsed;
  const deleting = useMissionStore(
    (s) => !!s.deletingMissions[mission.id],
  );
  const selectedItem = useMissionStore((s) => s.selectedItem);
  const toggleCollapse = useMissionStore((s) => s.toggleCollapse);
  const selectItem = useMissionStore((s) => s.selectItem);
  const deleteMission = useMissionStore((s) => s.deleteMission);

  const [showAddProject, setShowAddProject] = useState(false);
  const noteKey = getNoteKey({ type: "mission", missionId: mission.id });
  const aiSessions = useAiWorktreeSessions(mission.missionDir);

  const isMissionSelected =
    selectedItem?.missionId === mission.id && !selectedItem?.projectId;

  const handleSelectMission = () => {
    if (deleting) return;
    selectItem(mission.id);
    useTerminalStore.getState().setActiveWorktree(mission.missionDir);
  };

  const handleToggleCollapse = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (deleting) return;
    toggleCollapse(mission.id);
  };

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (deleting) return;
    const confirmed = await overlay.confirm({
      title: "Delete mission?",
      description: `Delete mission "${mission.name}"? This will remove all project associations.`,
      confirmLabel: "Delete mission",
      variant: "destructive",
    });
    if (!confirmed) return;
    await deleteMission(mission.id);
  };

  return (
    <SidebarContextMenu path={mission.missionDir} noteKey={noteKey} noteLabel={mission.name}>
    <div className={cn("px-1.5")}>
      <div
        className={cn(
          "group flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] transition-all duration-150 cursor-pointer select-none",
          {
            "bg-selected text-foreground": isMissionSelected && !deleting,
            "text-foreground hover:bg-secondary/50": !isMissionSelected && !deleting,
            "pointer-events-none opacity-50": deleting,
          },
        )}
        onClick={handleSelectMission}
      >
        <button
          className={cn(
            "flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground",
          )}
          onClick={handleToggleCollapse}
          title={collapsed ? "Expand mission" : "Collapse mission"}
        >
          {collapsed ? (
            <ChevronRight className={cn("h-[15px] w-[15px]")} />
          ) : (
            <ChevronDown className={cn("h-[15px] w-[15px]")} />
          )}
        </button>
        <span
          className={cn("min-w-0 flex-1 truncate font-medium", {
            "text-accent": isMissionSelected,
          })}
        >
          {mission.name}<NoteEmoji noteKey={noteKey} label={mission.name} />
        </span>
        {collapsed && mission.projects.length > 0 && (
          <Badge variant="secondary" className={cn("text-[10px] h-4 px-1.5")}>
            {mission.projects.length}
          </Badge>
        )}
        <AiStatusIcons sessions={aiSessions} />
        <div className={cn(
          "ml-auto flex shrink-0 items-center gap-0.5 overflow-hidden transition-all duration-150",
          {
            "max-w-0 opacity-0": !isMissionSelected,
            "max-w-[50px] opacity-100": isMissionSelected,
            "group-hover:max-w-[50px] group-hover:opacity-100": true,
          },
        )}>
          <IconButton
            onClick={(e) => {
              e.stopPropagation();
              if (deleting) return;
              setShowAddProject(!showAddProject);
            }}
            title="Add project"
          >
            <Plus className={cn("h-[13px] w-[13px]")} />
          </IconButton>
          {deleting ? (
            <Loader2 className={cn("h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground")} />
          ) : (
            <IconButton
              onClick={handleDelete}
              title="Delete mission"
            >
              <X className={cn("h-[13px] w-[13px]")} />
            </IconButton>
          )}
        </div>
      </div>

      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-200 ease-out",
          {
            "grid-rows-[1fr]": !collapsed,
            "grid-rows-[0fr]": collapsed,
          },
        )}
      >
        <div className={cn("overflow-hidden")}>
          <div className={cn("ml-4 border-l border-border/80 pl-2")}>
            {mission.projects.map((project) => (
              <MissionProjectItem
                key={project.projectId}
                missionId={mission.id}
                project={project}
              />
            ))}
            {showAddProject && !deleting && (
              <AddProjectToMissionDialog
                missionId={mission.id}
                existingProjectIds={mission.projects.map((p) => p.projectId)}
                onClose={() => setShowAddProject(false)}
              />
            )}
          </div>
        </div>
      </div>
    </div>
    </SidebarContextMenu>
  );
}

export default MissionItem;
