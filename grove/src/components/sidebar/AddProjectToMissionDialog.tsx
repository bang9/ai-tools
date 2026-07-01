import { useProjectStore } from "../../store/project";
import { useMissionStore } from "../../store/mission";
import { Button } from "../ui/button";
import { cn } from "../../lib/cn";

interface Props {
  missionId: string;
  existingProjectIds: string[];
  onClose: () => void;
}

function AddProjectToMissionDialog({
  missionId,
  existingProjectIds,
  onClose,
}: Props) {
  const projects = useProjectStore((s) => s.projects);
  const addProject = useMissionStore((s) => s.addProject);

  const available = projects.filter(
    (p) => !existingProjectIds.includes(p.id),
  );

  const handleSelect = (projectId: string) => {
    // Close the selection list immediately; the mission tree shows a loading
    // placeholder while the add runs in the background. Failures surface via a
    // toast from the store; swallow the rejection here so the fire-and-forget
    // call does not become an unhandled promise rejection.
    onClose();
    void addProject(missionId, projectId).catch(() => {});
  };

  return (
    <div className={cn("px-1 py-1")}>
      {available.length === 0 ? (
        <div className={cn("px-2 py-2 text-[11px] text-muted-foreground")}>
          All projects already added
        </div>
      ) : (
        available.map((project) => (
          <button
            key={project.id}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1 text-[13px] transition-colors",
              "text-muted-foreground hover:bg-secondary/50 hover:text-foreground",
            )}
            onClick={() => handleSelect(project.id)}
          >
            <span className={cn("min-w-0 flex-1 truncate text-left")}>
              {project.org}/{project.repo}
            </span>
          </button>
        ))
      )}
      <div className={cn("flex justify-end px-1 pt-1")}>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          className={cn("text-[11px] h-6")}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

export default AddProjectToMissionDialog;
