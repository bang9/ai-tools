export interface Project {
  id: string;
  name: string;
  url: string;
  org: string;
  repo: string;
  sourcePath: string;
  worktrees: Worktree[];
  sourceHasChanges: boolean;
  sourceBehindRemote: boolean;
  baseBranch: string | null;
  resolvedDefaultBranch: string;
  collapsed: boolean;
  categoryId: string;
}

export interface Worktree {
  name: string;
  path: string;
  branch: string;
  stackParentName?: string | null;
}

export type WorktreePullRequestStatus = "open" | "merged" | "unknown";

export interface WorktreePullRequest {
  url: string;
  status: WorktreePullRequestStatus;
}

export interface ProjectEnvSyncConfig {
  include_patterns: string[];
}

export interface CloningProject {
  id: string;
  url: string;
  org: string;
  repo: string;
}

export type StartCloneResult =
  | ({ type: "cloning" } & CloningProject)
  | ({ type: "alreadyExists" } & Project);
