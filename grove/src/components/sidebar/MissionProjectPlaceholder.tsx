import { FolderGit2, Loader2 } from "lucide-react";
import { useProjectStore } from "../../store/project";
import { cn } from "../../lib/cn";

interface Props {
  projectId: string;
}

function MissionProjectPlaceholder({ projectId }: Props) {
  const projects = useProjectStore((s) => s.projects);
  const projectData = projects.find((p) => p.id === projectId);
  const projectLabel =
    projectData && projectData.name !== projectData.repo
      ? projectData.name
      : projectData && `${projectData.org}/${projectData.repo}`;
  const displayName = projectLabel ?? "Adding project…";

  return (
    <div
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1 text-[13px] opacity-60 select-none",
      )}
      title={displayName}
    >
      <FolderGit2 className={cn("h-[13px] w-[13px] shrink-0 text-muted-foreground")} />
      <span className={cn("min-w-0 flex-1 truncate text-muted-foreground")}>{displayName}</span>
      <Loader2 className={cn("h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground")} />
    </div>
  );
}

export default MissionProjectPlaceholder;
