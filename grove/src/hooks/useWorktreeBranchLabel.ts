import { useMemo } from "react";
import { useMissionStore } from "../store/mission";
import { useProjectStore } from "../store/project";
import { resolveWorktreeBranchLabel } from "../lib/worktree-branch";

export function useWorktreeBranchLabel(worktreePath: string | null): string | null {
  const projects = useProjectStore((state) => state.projects);
  const missions = useMissionStore((state) => state.missions);

  return useMemo(
    () => resolveWorktreeBranchLabel({ projects, missions, worktreePath }),
    [projects, missions, worktreePath],
  );
}
