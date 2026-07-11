export type {
  Project,
  Worktree,
  WorktreePullRequest,
  WorktreePullRequestStatus,
  ProjectEnvSyncConfig,
  CloningProject,
  StartCloneResult,
} from "./project";
export type { Mission, MissionProject } from "./mission";
export type { TerminalTheme, PtySession, SplitNode } from "./terminal";
export type {
  BehindInfo,
  CommitInfo,
  DirectoryFileEntry,
  DeepDirectoryListing,
  WorkspaceFileKind,
  WorkspaceFileContent,
  FileStatus,
  DiffLine,
  DiffHunk,
  FileDiff,
} from "./diff";
export type { AppTab, AppTabType } from "./tab";
export type {
  EnvValueSource,
  PathDiagnostics,
  ProcessEnvDiagnostics,
  SshAuthSockDiagnostics,
  SubprocessEnvVar,
} from "./env";

export type TerminalLinkOpenMode = "external" | "internal" | "external-with-localhost-internal";

export type ProjectViewMode = "default" | "group-by-orgs";

export type ProjectCategoryIconId =
  | "sprout"
  | "folder"
  | "rocket"
  | "flame"
  | "bug"
  | "wrench"
  | "book"
  | "palette"
  | "database"
  | "bot"
  | "terminal"
  | "briefcase"
  | "star"
  | "package"
  | "code"
  | "gem";

export type ProjectCategoryIcon =
  | { type: "emoji"; value: string }
  | { type: "lucide"; value: ProjectCategoryIconId };

export interface ProjectCategory {
  id: string;
  name: string;
  color: string;
  icon: ProjectCategoryIcon;
}

export interface IdeMenuItem {
  id: string;
  displayName?: string;
  openCommand?: string;
}

export type GitGuiMenuItem = IdeMenuItem;

export interface GrovePreferences {
  terminalLinkOpenMode: TerminalLinkOpenMode;
  projectViewMode: ProjectViewMode;
  collapsedProjectOrgs: string[];
  projectOrgOrder: string[];
  ideMenuItems: IdeMenuItem[];
  gitGuiMenuItems: GitGuiMenuItem[];
  projectCategories: ProjectCategory[];
}

export interface AppConfig {
  baseDir: string;
  terminalTheme?: Partial<import("./terminal").TerminalTheme>;
  preferences: GrovePreferences;
}
