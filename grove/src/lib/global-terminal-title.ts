import type { Project, Worktree } from "../types";

function getProjectRepoLabel(project: Project): string {
  return project.org.trim() ? `${project.org}/${project.repo}` : project.repo;
}

export function findProjectForWorktreePath(
  projects: Project[],
  worktreePath: string | null | undefined,
): Project | null {
  if (!worktreePath) {
    return null;
  }

  return (
    projects.find(
      (project) =>
        project.sourcePath === worktreePath ||
        project.worktrees.some((worktree) => worktree.path === worktreePath),
    ) ?? null
  );
}

export function getGlobalTerminalMirrorTitle(
  projects: Project[],
  worktree: Worktree | null,
): string {
  if (!worktree) {
    return "Terminal";
  }

  const project = findProjectForWorktreePath(projects, worktree.path);
  const label = project ? getProjectRepoLabel(project) : "Terminal";
  const suffix = project?.sourcePath === worktree.path ? worktree.branch : worktree.name;

  return `${label} > ${suffix}`;
}
