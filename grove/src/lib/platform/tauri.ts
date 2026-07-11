import { Channel, invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { routePtyOutput } from "../terminal-output-router";
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
  DirectoryFileEntry,
  DeepDirectoryListing,
  WorkspaceFileContent,
  CommitInfo,
  FileDiff,
  Mission,
  MissionProject,
  ProjectEnvSyncConfig,
  StartCloneResult,
} from "../../types";
import type {
  BrowserBounds,
  BrowserNavEvent,
  BrowserNewWindowEvent,
  DetectedBrowser,
  Platform,
  PtyOutputTransport,
  UnlistenFn,
} from "./types";

export const windowDragRegionProps = {
  "data-tauri-drag-region": "",
} as const;

/**
 * Tauri delivers PTY output through a per-PTY `tauri::ipc::Channel` (raw
 * ArrayBuffer) wired in {@link createPty}, not the shared global `pty-output`
 * event, so terminal-runtime skips the Electron-only global output listener.
 */
export const ptyOutputTransport: PtyOutputTransport = "channel";

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
  reapedPtyIds: string[];
  deadReaderPtyIds: string[];
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
    .replace(/(^|[\s('"])(\/(?:Users|home|private|tmp|var|Volumes)[^'"\s)\n]*)/g, "$1[path]")
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

export async function saveGrovePreferences(preferences: GrovePreferences): Promise<void> {
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

export async function saveUiState(state: string): Promise<void> {
  return platform.invoke("save_ui_state", { state });
}

export async function loadUiState(): Promise<string> {
  return platform.invoke<string>("load_ui_state");
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

export async function createProject(name: string, path: string): Promise<Project> {
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

export async function removeWorktree(projectId: string, name: string): Promise<void> {
  return platform.invoke("remove_worktree", { projectId, name });
}

export async function listWorktrees(projectId: string): Promise<Worktree[]> {
  return platform.invoke<Worktree[]>("list_worktrees", { projectId });
}

export async function getWorktreePrUrl(worktreePath: string): Promise<WorktreePullRequest | null> {
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

export async function setProjectCategory(projectId: string, categoryId: string): Promise<void> {
  return platform.invoke("set_project_category", { projectId, categoryId });
}

export async function deleteProjectCategory(categoryId: string): Promise<void> {
  return platform.invoke("delete_project_category", { categoryId });
}

export async function setProjectCollapsed(projectId: string, collapsed: boolean): Promise<void> {
  return platform.invoke("set_project_collapsed", { projectId, collapsed });
}

export async function setProjectFocus(projectId: string, focused: boolean): Promise<void> {
  return platform.invoke("set_project_focus", { projectId, focused });
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

// === BROWSER COMMANDS ===

export async function browserCreate(
  tabId: string,
  url: string,
  bounds: BrowserBounds,
): Promise<void> {
  return platform.invoke("browser_create", { tabId, url, bounds });
}

export async function browserNavigate(tabId: string, url: string): Promise<void> {
  return platform.invoke("browser_navigate", { tabId, url });
}

export async function browserGoBack(tabId: string): Promise<void> {
  return platform.invoke("browser_go_back", { tabId });
}

export async function browserGoForward(tabId: string): Promise<void> {
  return platform.invoke("browser_go_forward", { tabId });
}

export async function browserReload(tabId: string): Promise<void> {
  return platform.invoke("browser_reload", { tabId });
}

export async function browserSetBounds(tabId: string, bounds: BrowserBounds): Promise<void> {
  return platform.invoke("browser_set_bounds", { tabId, bounds });
}

export async function browserSetVisible(tabId: string, visible: boolean): Promise<void> {
  return platform.invoke("browser_set_visible", { tabId, visible });
}

export async function browserClose(tabId: string): Promise<void> {
  return platform.invoke("browser_close", { tabId });
}

export async function browserCloseAll(): Promise<void> {
  return platform.invoke("browser_close_all");
}

export async function browserOpenDevtools(tabId: string): Promise<void> {
  return platform.invoke("browser_open_devtools", { tabId });
}

export async function browserDetectBrowsers(): Promise<DetectedBrowser[]> {
  return platform.invoke("detect_installed_browsers");
}

/** Import cookies from `family` into the browser session; resolves to the count set. */
export async function browserImportCookies(family: string, host?: string): Promise<number> {
  return platform.invoke("browser_import_cookies", { family, host });
}

/**
 * Tauri's Webview exposes no session-history API, so back/forward are driven
 * by the frontend URL stack via explicit navigation.
 */
export const browserHasNativeHistory = false;

export function onBrowserNav(handler: (event: BrowserNavEvent) => void): Promise<UnlistenFn> {
  return platform.listen<BrowserNavEvent>("browser:nav", handler);
}

export function onBrowserNewWindow(
  handler: (event: BrowserNewWindowEvent) => void,
): Promise<UnlistenFn> {
  return platform.listen<BrowserNewWindowEvent>("browser:new-window", handler);
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

export async function createPty(request: CreatePtyRequest): Promise<CreatePtyResult> {
  // A per-PTY channel carries raw output bytes as an ArrayBuffer with no base64
  // and no JSON number-array blowup. Its onmessage routes by the immutable
  // ptyId, so pane re-acquire / ptyId reassignment is handled entirely by the
  // output router (the owning runtime registers/unregisters its handler); the
  // channel itself never needs re-creation. Tauri unregisters the JS callback
  // when the Rust channel drops (PTY reader EOF), so there is nothing to tear
  // down here.
  const { ptyId } = request;
  const onOutput = new Channel<ArrayBuffer>();
  onOutput.onmessage = (message) => {
    routePtyOutput(ptyId, new Uint8Array(message));
  };
  return tauriInvoke<CreatePtyResult>("create_pty", { ...request, onOutput });
}

export async function writePty(id: string, data: Uint8Array): Promise<void> {
  // A Uint8Array nested in a JSON args object degrades to a JSON number array
  // (~4x blowup) under Tauri's IPC serializer. Passing it as the top-level
  // payload ships it as an application/octet-stream raw body (Vec<u8> on the
  // Rust side); the ptyId rides a header since the raw body replaces the whole
  // argument object.
  return tauriInvoke("write_pty", data, { headers: { "pty-id": id } });
}

export async function resizePty(id: string, cols: number, rows: number): Promise<void> {
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

export async function runTerminalGc(dryRun = false): Promise<TerminalGcReport> {
  return platform.invoke<TerminalGcReport>("run_terminal_gc", { dryRun });
}

// === GIT DIFF COMMANDS (W4) ===

export async function getStatus(worktreePath: string): Promise<FileStatus[]> {
  return platform.invoke<FileStatus[]>("get_status", { worktreePath });
}

export async function listDirectoryFiles(
  rootPath: string,
  parentPath: string | null = null,
): Promise<DirectoryFileEntry[]> {
  return platform.invoke<DirectoryFileEntry[]>("list_directory_files", {
    rootPath,
    parentPath,
  });
}

export async function listDirectoryFilesDeep(rootPath: string): Promise<DeepDirectoryListing> {
  return platform.invoke<DeepDirectoryListing>("list_directory_files_deep", { rootPath });
}

export async function readWorkspaceFile(
  rootPath: string,
  filePath: string,
): Promise<WorkspaceFileContent> {
  return platform.invoke<WorkspaceFileContent>("read_workspace_file", { rootPath, filePath });
}

export async function getCommits(worktreePath: string, limit: number): Promise<CommitInfo[]> {
  return platform.invoke<CommitInfo[]>("get_commits", { worktreePath, limit });
}

export async function getWorkingDiff(worktreePath: string, path: string): Promise<FileDiff> {
  return platform.invoke<FileDiff>("get_working_diff", { worktreePath, path });
}

export async function getCommitDiff(worktreePath: string, hash: string): Promise<FileDiff[]> {
  return platform.invoke<FileDiff[]>("get_commit_diff", { worktreePath, hash });
}

export async function getWorkingDiffContext(
  worktreePath: string,
  path: string,
  startLine: number,
  lineCount: number,
): Promise<string[]> {
  return platform.invoke<string[]>("get_working_diff_context", {
    worktreePath,
    path,
    startLine,
    lineCount,
  });
}

export async function getCommitDiffContext(
  worktreePath: string,
  hash: string,
  path: string,
  oldPath: string | null,
  startLine: number,
  lineCount: number,
): Promise<string[]> {
  return platform.invoke<string[]>("get_commit_diff_context", {
    worktreePath,
    hash,
    path,
    oldPath,
    startLine,
    lineCount,
  });
}

export async function stageFile(worktreePath: string, path: string): Promise<void> {
  return platform.invoke("stage_file", { worktreePath, path });
}

export async function stageFiles(worktreePath: string, paths: string[]): Promise<void> {
  return platform.invoke("stage_files", { worktreePath, paths });
}

export async function unstageFile(worktreePath: string, path: string): Promise<void> {
  return platform.invoke("unstage_file", { worktreePath, path });
}

export async function unstageFiles(worktreePath: string, paths: string[]): Promise<void> {
  return platform.invoke("unstage_files", { worktreePath, paths });
}

export async function discardFile(worktreePath: string, path: string): Promise<void> {
  return platform.invoke("discard_file", { worktreePath, path });
}

export async function discardFiles(worktreePath: string, paths: string[]): Promise<void> {
  return platform.invoke("discard_files", { worktreePath, paths });
}

export async function removeUntrackedFiles(worktreePath: string, paths: string[]): Promise<void> {
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

export async function getBehindCount(worktreePath: string): Promise<BehindInfo> {
  return platform.invoke<BehindInfo>("get_behind_count", { worktreePath });
}

export async function mergeDefaultBranch(worktreePath: string): Promise<void> {
  return platform.invoke("merge_default_branch", { worktreePath });
}

// === MISSION COMMANDS (W5) ===

export async function listMissions(): Promise<Mission[]> {
  return platform.invoke<Mission[]>("list_missions");
}

export async function createMission(name: string, branchName?: string | null): Promise<Mission> {
  return platform.invoke<Mission>("create_mission", {
    name,
    branchName: branchName ?? null,
  });
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
