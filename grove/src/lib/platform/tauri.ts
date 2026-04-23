import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type {
  TerminalTheme,
  AppConfig,
  GrovePreferences,
  IdeMenuItem,
  ProcessEnvDiagnostics,
  Project,
  Worktree,
  WorktreePullRequest,
  BehindInfo,
  FileStatus,
  CommitInfo,
  FileDiff,
  Mission,
  MissionProject,
  ProjectEnvSyncConfig,
  StartCloneResult,
} from "../../types";
import type { Platform } from "./types";

export const windowDragRegionProps = {
  "data-tauri-drag-region": "",
} as const;

export const platform: Platform = {
  invoke<T>(cmd: string, args?: Record<string, unknown>) {
    return tauriInvoke<T>(cmd, args);
  },
  listen<T = unknown>(event: string, handler: (payload: T) => void) {
    return tauriListen<T>(event, ({ payload }) => handler(payload));
  },
  isFullscreen() {
    return getCurrentWindow().isFullscreen();
  },
  onResized(handler: () => void) {
    return getCurrentWindow().onResized(() => {
      handler();
    });
  },
};

// Terminal session snapshots are keyed by stable paneId. ptyId is only an
// optional runtime lookup handle for backend-enriched scrollback/cwd capture.
export type TerminalRestoreCwdSource = "launchCwd" | "lastKnownCwd";

export interface CreatePtyRestore {
  lastKnownCwd?: string | null;
  scrollback?: string | null;
  scrollbackTruncated?: boolean | null;
}

export interface CreatePtyRequest {
  ptyId: string;
  paneId: string;
  worktreePath: string;
  cwd: string;
  cols: number;
  rows: number;
  restore?: CreatePtyRestore | null;
}

export type CreatePtySessionState = "attached" | "created";

export interface CreatePtyInitialHydration {
  text: string;
  truncated: boolean;
  source: "tmuxCapture";
}

export interface CreatePtyResult {
  sessionState: CreatePtySessionState;
  initialHydration?: CreatePtyInitialHydration | null;
}

export interface PtyBellEvent {
  ptyId: string;
  bell: boolean;
  /** AI status in "tool:status" format (e.g. "claude:running", "codex:running"). */
  aiStatus: string | null;
}

export interface TerminalPaneSnapshotInput {
  paneId: string;
  ptyId?: string | null;
  launchCwd?: string | null;
}

export interface SaveTerminalSessionSnapshotRequest {
  worktreePath: string;
  panes: TerminalPaneSnapshotInput[];
}

export interface TerminalPaneSnapshot {
  paneId: string;
  scrollback: string;
  scrollbackTruncated: boolean;
  launchCwd: string;
  lastKnownCwd: string | null;
  restoreCwd: string;
  restoreCwdSource: TerminalRestoreCwdSource;
}

export interface TerminalSessionSnapshot {
  worktreePath: string;
  panes: TerminalPaneSnapshot[];
}

export interface TerminalGcReport {
  staleWorktreePaths: string[];
  staleSessionNames: string[];
  prunedWorktreePaths: string[];
  killedSessionNames: string[];
  skippedAttachedWorktreePaths: string[];
  leftoverProcessIds: number[];
}

export function getCommandErrorMessage(error: unknown): string {
  let raw: string;
  if (typeof error === "string") {
    raw = error;
  } else if (error instanceof Error) {
    raw = error.message;
  } else {
    raw = String(error);
  }
  const message = sanitizeCommandErrorMessage(raw);
  return message || "Unknown error";
}

export function sanitizeCommandErrorMessage(message: string): string {
  return message
    .replace(/^Error invoking command '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .replace(/Cloning into '[^']+'\.{3}/g, "Cloning repository...")
    .replace(/(https?:\/\/)([^@\s/]+(?::[^@\s/]+)?@)/gi, "$1***@")
    .replace(
      /(^|[\s('"])(\/(?:Users|home|private|tmp|var|Volumes)[^'"\s)\n]*)/g,
      "$1[path]",
    )
    .trim();
}

// === CONFIG/THEME COMMANDS (W1) ===

export async function getTerminalTheme(): Promise<{ theme: TerminalTheme; detected: boolean }> {
  return platform.invoke<{ theme: TerminalTheme; detected: boolean }>("get_terminal_theme");
}

export async function getAppConfig(): Promise<AppConfig> {
  return platform.invoke<AppConfig>("get_app_config");
}

export async function getGrovePreferences(): Promise<GrovePreferences> {
  return platform.invoke<GrovePreferences>("get_grove_preferences");
}

export async function getProcessEnvDiagnostics(): Promise<ProcessEnvDiagnostics> {
  return platform.invoke<ProcessEnvDiagnostics>("get_process_env_diagnostics");
}

export async function saveAppConfig(config: AppConfig): Promise<void> {
  return platform.invoke("save_app_config", { config });
}

export async function saveGrovePreferences(
  preferences: GrovePreferences,
): Promise<void> {
  return platform.invoke("save_grove_preferences", { preferences });
}

// === TERMINAL LAYOUT PERSISTENCE ===

export async function saveTerminalLayouts(layouts: string): Promise<void> {
  return platform.invoke("save_terminal_layouts", { layouts });
}

export async function loadTerminalLayouts(): Promise<string> {
  return platform.invoke<string>("load_terminal_layouts");
}

export async function savePanelLayouts(layouts: string): Promise<void> {
  return platform.invoke("save_panel_layouts", { layouts });
}

export async function loadPanelLayouts(): Promise<string> {
  return platform.invoke<string>("load_panel_layouts");
}

// === GIT PROJECT COMMANDS (W2) ===

export async function listProjects(): Promise<Project[]> {
  return platform.invoke<Project[]>("list_projects");
}

export async function startClone(url: string): Promise<StartCloneResult> {
  return platform.invoke<StartCloneResult>("start_clone", { url });
}

export function onCloneCompleted(
  handler: (payload: { id: string; project: Project }) => void,
): Promise<import("./types").UnlistenFn> {
  return platform.listen<{ id: string; project: Project }>("grove:clone-completed", handler);
}

export function onCloneFailed(
  handler: (payload: { id: string; error: string }) => void,
): Promise<import("./types").UnlistenFn> {
  return platform.listen<{ id: string; error: string }>("grove:clone-failed", handler);
}

export async function createProject(
  name: string,
  path: string,
): Promise<Project> {
  return platform.invoke<Project>("create_project", { name, path });
}

export async function removeProject(id: string): Promise<void> {
  return platform.invoke("remove_project", { id });
}

export async function reorderProjects(projectIds: string[]): Promise<void> {
  return platform.invoke("reorder_projects", { projectIds });
}

export async function refreshProject(projectId: string): Promise<Project> {
  return platform.invoke<Project>("refresh_project", { projectId });
}

export async function addWorktree(
  projectId: string,
  name: string,
  branch: string,
): Promise<Worktree> {
  return platform.invoke<Worktree>("add_worktree", { projectId, name, branch });
}

export async function addStackedWorktree(
  projectId: string,
  parentName: string,
  name: string,
): Promise<Worktree> {
  return platform.invoke<Worktree>("add_stacked_worktree", {
    projectId,
    parentName,
    name,
  });
}

export async function removeWorktree(
  projectId: string,
  name: string,
): Promise<void> {
  return platform.invoke("remove_worktree", { projectId, name });
}

export async function listWorktrees(projectId: string): Promise<Worktree[]> {
  return platform.invoke<Worktree[]>("list_worktrees", { projectId });
}

export async function getWorktreePrUrl(
  worktreePath: string,
): Promise<WorktreePullRequest | null> {
  return platform.invoke<WorktreePullRequest | null>("get_worktree_pr_url", { worktreePath });
}

export async function createWorktreePr(worktreePath: string): Promise<void> {
  return platform.invoke("create_worktree_pr", { worktreePath });
}

// Phase 2: 드래그 재정렬 완료 시 호출하여 커스텀 순서를 영속화
export async function setWorktreeOrder(projectId: string, order: string[]): Promise<void> {
  return platform.invoke<void>("set_worktree_order", { projectId, order });
}

export async function getRemoteBranches(projectId: string): Promise<string[]> {
  return platform.invoke<string[]>("get_remote_branches", { projectId });
}

export async function renameProject(projectId: string, name: string): Promise<void> {
  return platform.invoke("rename_project", { projectId, name });
}

export async function setProjectCategory(
  projectId: string,
  categoryId: string,
): Promise<void> {
  return platform.invoke("set_project_category", { projectId, categoryId });
}

export async function deleteProjectCategory(categoryId: string): Promise<void> {
  return platform.invoke("delete_project_category", { categoryId });
}

export async function setProjectCollapsed(projectId: string, collapsed: boolean): Promise<void> {
  return platform.invoke("set_project_collapsed", { projectId, collapsed });
}

export async function setBaseBranch(projectId: string, branch: string | null): Promise<void> {
  return platform.invoke("set_base_branch", { projectId, branch });
}

export async function openExternal(url: string): Promise<void> {
  return platform.invoke("open_external", { url });
}

export async function revealInFinder(path: string): Promise<void> {
  return platform.invoke("reveal_in_finder", { path });
}

export async function openInIde(path: string, ideMenuItem: IdeMenuItem): Promise<void> {
  return platform.invoke("open_in_ide", { path, ideMenuItem });
}

export async function openDevConsole(): Promise<void> {
  return platform.invoke("open_dev_console");
}

export async function reloadAppWindow(): Promise<void> {
  return platform.invoke("reload_app_window");
}

// === ENV SYNC COMMANDS ===

export async function setEnvSync(projectId: string, config: ProjectEnvSyncConfig): Promise<void> {
  return platform.invoke("set_env_sync", { projectId, config });
}

export async function getEnvSync(projectId: string): Promise<ProjectEnvSyncConfig | null> {
  return platform.invoke<ProjectEnvSyncConfig | null>("get_env_sync", { projectId });
}

export async function listGitignorePatterns(projectId: string): Promise<string[]> {
  return platform.invoke<string[]>("list_gitignore_patterns", { projectId });
}

// === PTY COMMANDS (W3) ===

export async function createPty(
  request: CreatePtyRequest,
): Promise<CreatePtyResult> {
  return platform.invoke<CreatePtyResult>("create_pty", { ...request });
}

export async function writePty(id: string, data: number[]): Promise<void> {
  return platform.invoke("write_pty", { id, data });
}

export async function resizePty(
  id: string,
  cols: number,
  rows: number,
): Promise<void> {
  return platform.invoke("resize_pty", { id, cols, rows });
}

export async function clearPtyScrollback(ptyId: string): Promise<void> {
  return platform.invoke("clear_pty_scrollback", { ptyId });
}

export async function closePty(ptyId: string): Promise<void> {
  return platform.invoke("close_pty", { ptyId });
}

export async function pollPtyBells(): Promise<PtyBellEvent[]> {
  return platform.invoke<PtyBellEvent[]>("poll_pty_bells");
}

export async function saveTerminalSessionSnapshot(
  snapshot: SaveTerminalSessionSnapshotRequest,
): Promise<TerminalSessionSnapshot> {
  return platform.invoke<TerminalSessionSnapshot>("save_terminal_session_snapshot", {
    snapshot,
  });
}

export async function loadTerminalSessionSnapshot(
  worktreePath: string,
): Promise<TerminalSessionSnapshot | null> {
  return platform.invoke<TerminalSessionSnapshot | null>("load_terminal_session_snapshot", {
    worktreePath,
  });
}

export async function runTerminalGc(
  dryRun = false,
): Promise<TerminalGcReport> {
  return platform.invoke<TerminalGcReport>("run_terminal_gc", { dryRun });
}

// === GIT DIFF COMMANDS (W4) ===

export async function getStatus(worktreePath: string): Promise<FileStatus[]> {
  return platform.invoke<FileStatus[]>("get_status", { worktreePath });
}

export async function getCommits(
  worktreePath: string,
  limit: number,
): Promise<CommitInfo[]> {
  return platform.invoke<CommitInfo[]>("get_commits", { worktreePath, limit });
}

export async function getWorkingDiff(
  worktreePath: string,
  path: string,
): Promise<FileDiff> {
  return platform.invoke<FileDiff>("get_working_diff", { worktreePath, path });
}

export async function getCommitDiff(
  worktreePath: string,
  hash: string,
): Promise<FileDiff[]> {
  return platform.invoke<FileDiff[]>("get_commit_diff", { worktreePath, hash });
}

export async function stageFile(
  worktreePath: string,
  path: string,
): Promise<void> {
  return platform.invoke("stage_file", { worktreePath, path });
}

export async function stageFiles(
  worktreePath: string,
  paths: string[],
): Promise<void> {
  return platform.invoke("stage_files", { worktreePath, paths });
}

export async function unstageFile(
  worktreePath: string,
  path: string,
): Promise<void> {
  return platform.invoke("unstage_file", { worktreePath, path });
}

export async function unstageFiles(
  worktreePath: string,
  paths: string[],
): Promise<void> {
  return platform.invoke("unstage_files", { worktreePath, paths });
}

export async function discardFile(
  worktreePath: string,
  path: string,
): Promise<void> {
  return platform.invoke("discard_file", { worktreePath, path });
}

export async function discardFiles(
  worktreePath: string,
  paths: string[],
): Promise<void> {
  return platform.invoke("discard_files", { worktreePath, paths });
}

export async function removeUntrackedFiles(
  worktreePath: string,
  paths: string[],
): Promise<void> {
  return platform.invoke("remove_untracked_files", { worktreePath, paths });
}

export async function stageHunk(
  worktreePath: string,
  path: string,
  hunkIndex: number,
): Promise<void> {
  return platform.invoke("stage_hunk", { worktreePath, path, hunkIndex });
}

export async function unstageHunk(
  worktreePath: string,
  path: string,
  hunkIndex: number,
): Promise<void> {
  return platform.invoke("unstage_hunk", { worktreePath, path, hunkIndex });
}

export async function discardHunk(
  worktreePath: string,
  path: string,
  hunkIndex: number,
): Promise<void> {
  return platform.invoke("discard_hunk", { worktreePath, path, hunkIndex });
}

export async function stageLines(
  worktreePath: string,
  path: string,
  hunkIndex: number,
  lineIndices: number[],
): Promise<void> {
  return platform.invoke("stage_lines", { worktreePath, path, hunkIndex, lineIndices });
}

export async function unstageLines(
  worktreePath: string,
  path: string,
  hunkIndex: number,
  lineIndices: number[],
): Promise<void> {
  return platform.invoke("unstage_lines", {
    worktreePath,
    path,
    hunkIndex,
    lineIndices,
  });
}

export async function discardLines(
  worktreePath: string,
  path: string,
  hunkIndex: number,
  lineIndices: number[],
): Promise<void> {
  return platform.invoke("discard_lines", {
    worktreePath,
    path,
    hunkIndex,
    lineIndices,
  });
}

// === GIT MERGE COMMANDS ===

export async function getBehindCount(
  worktreePath: string,
): Promise<BehindInfo> {
  return platform.invoke<BehindInfo>("get_behind_count", { worktreePath });
}

export async function mergeDefaultBranch(
  worktreePath: string,
): Promise<void> {
  return platform.invoke("merge_default_branch", { worktreePath });
}

// === MISSION COMMANDS (W5) ===

export async function listMissions(): Promise<Mission[]> {
  return platform.invoke<Mission[]>("list_missions");
}

export async function createMission(name: string): Promise<Mission> {
  return platform.invoke<Mission>("create_mission", { name });
}

export async function deleteMission(id: string): Promise<void> {
  return platform.invoke("delete_mission", { id });
}

export async function setMissionCollapsed(missionId: string, collapsed: boolean): Promise<void> {
  return platform.invoke("set_mission_collapsed", { missionId, collapsed });
}

export async function addProjectToMission(
  missionId: string,
  projectId: string,
): Promise<MissionProject> {
  return platform.invoke<MissionProject>("add_project_to_mission", {
    missionId,
    projectId,
  });
}

export async function removeProjectFromMission(
  missionId: string,
  projectId: string,
): Promise<void> {
  return platform.invoke("remove_project_from_mission", {
    missionId,
    projectId,
  });
}

// === NOTE COMMANDS ===

export async function listNotes(): Promise<Record<string, string>> {
  return platform.invoke<Record<string, string>>("list_notes");
}

export async function saveNote(key: string, content: string): Promise<void> {
  return platform.invoke("save_note", { key, content });
}

export async function deleteNote(key: string): Promise<void> {
  return platform.invoke("delete_note", { key });
}
