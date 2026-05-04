import type { Mission, Project } from "../types";

interface ResolveWorktreeBranchLabelInput {
  projects: Project[];
  missions: Mission[];
  worktreePath: string | null | undefined;
}

export function resolveWorktreeBranchLabel({
  projects,
  missions,
  worktreePath,
}: ResolveWorktreeBranchLabelInput): string | null {
  if (!worktreePath) {
    return null;
  }

  for (const mission of missions) {
    const missionProject = mission.projects.find(
      (project) => project.path === worktreePath,
    );
    if (missionProject?.branch) {
      return missionProject.branch;
    }
  }

  for (const project of projects) {
    if (project.sourcePath === worktreePath) {
      return project.resolvedDefaultBranch;
    }

    const worktree = project.worktrees.find((item) => item.path === worktreePath);
    if (worktree?.branch) {
      return worktree.branch;
    }
  }

  return null;
}
