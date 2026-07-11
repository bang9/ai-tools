import type React from "react";
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
  DevPermissionId,
  DevPermissionState,
  DevPermissionRequestResult,
} from "../../types";
import type {
  BrowserBounds,
  BrowserFaviconEvent,
  BrowserFindEvent,
  BrowserGrabEvent,
  BrowserNavEvent,
  BrowserNewWindowEvent,
  DetectedBrowser,
  Platform,
  PtyOutputTransport,
  UnlistenFn,
} from "./types";
import {
  domBrowserClose,
  domBrowserCloseAll,
  domBrowserCreate,
  domBrowserFind,
  domBrowserGoBack,
  domBrowserGoForward,
  domBrowserNavigate,
  domBrowserOpenDevtools,
  domBrowserReload,
  domBrowserSetVisible,
  domBrowserStopFind,
  emitDomBrowserNewWindow,
  onDomBrowserFavicon,
  onDomBrowserFind,
  onDomBrowserFindOpen,
  onDomBrowserNav,
  onDomBrowserNewWindow,
  registerBrowserHostDom,
} from "../browser-dom-webview";

interface GroveElectronBridge {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  on: (channel: string, handler: (...args: unknown[]) => void) => UnlistenFn;
}

declare global {
  interface Window {
    groveElectron?: GroveElectronBridge;
  }
}

function getBridge(): GroveElectronBridge {
  const bridge = typeof window !== "undefined" ? window.groveElectron : undefined;
  if (!bridge) {
    throw new Error("Electron bridge is not available on window.groveElectron");
  }

  return bridge;
}

export const windowDragRegionProps = {
  style: { WebkitAppRegion: "drag" } as React.CSSProperties,
} as const;

/**
 * Electron delivers PTY output on the shared global `pty-output` event carrying
 * `{ id, data }` (structured-clone Uint8Array), so terminal-runtime keeps the
 * single global output listener and routes by id.
 */
export const ptyOutputTransport: PtyOutputTransport = "globalEvent";

export const platform: Platform = {
  invoke<T>(cmd: string, args?: Record<string, unknown>) {
    return getBridge().invoke(cmd, args) as Promise<T>;
  },
  listen<T = unknown>(event: string, handler: (payload: T) => void) {
    return Promise.resolve(getBridge().on(event, (payload) => handler(payload as T)));
  },
  isFullscreen() {
    return getBridge().invoke("is_fullscreen") as Promise<boolean>;
  },
  onResized(handler: () => void) {
    window.addEventListener("resize", handler);
    return Promise.resolve(() => {
      window.removeEventListener("resize", handler);
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
  aiStatus: string | null;
}

/** Pane size tmux has actually applied — the grid the shell/TUI truly sees. */
export interface AppliedPtySize {
  cols: number;
  rows: number;
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

// Electron still uses synchronous add_project — wrap as alreadyExists result
export async function startClone(url: string): Promise<StartCloneResult> {
  const project = await platform.invoke<Project>("add_project", { url });
  return { type: "alreadyExists", ...project };
}

export function onCloneCompleted(
  _handler: (payload: { id: string; project: Project }) => void,
): Promise<import("./types").UnlistenFn> {
  // No-op on Electron — startClone is synchronous, result is immediate
  return Promise.resolve(() => {});
}

export function onCloneFailed(
  _handler: (payload: { id: string; error: string }) => void,
): Promise<import("./types").UnlistenFn> {
  // No-op on Electron — startClone is synchronous, errors are thrown directly
  return Promise.resolve(() => {});
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
  return platform.invoke("set_worktree_order", { projectId, order });
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
//
// Electron renders browser guests as in-DOM `<webview>` elements (orca-style),
// NOT the native WebContentsView. Because the guest lives in the document, the
// address dropdown and menus overlay the page through normal z-index stacking —
// no punchout, no push-down. All control/events below delegate to the in-DOM
// manager in lib/browser-dom-webview.ts; see that file for the mechanism and
// landmines. Cookie import / browser detection stay on IPC (main-process work).

/**
 * Register (or clear, on null) the React-owned host div a browser tab's
 * `<webview>` mounts into. Tauri no-ops this (native webview positioned by
 * bounds); Electron appends the in-DOM guest here.
 */
export function registerBrowserHost(tabId: string, el: HTMLElement | null): void {
  registerBrowserHostDom(tabId, el);
}

export async function browserCreate(
  tabId: string,
  url: string,
  _bounds: BrowserBounds,
): Promise<void> {
  // Bounds are irrelevant for an in-DOM guest — it fills its host via CSS.
  domBrowserCreate(tabId, url);
}

export async function browserNavigate(tabId: string, url: string): Promise<void> {
  domBrowserNavigate(tabId, url);
}

export async function browserGoBack(tabId: string): Promise<void> {
  domBrowserGoBack(tabId);
}

export async function browserGoForward(tabId: string): Promise<void> {
  domBrowserGoForward(tabId);
}

export async function browserReload(tabId: string): Promise<void> {
  domBrowserReload(tabId);
}

/** No-op: an in-DOM `<webview>` is positioned by CSS layout, not bounds. */
export async function browserSetBounds(_tabId: string, _bounds: BrowserBounds): Promise<void> {}

export async function browserSetVisible(tabId: string, visible: boolean): Promise<void> {
  domBrowserSetVisible(tabId, visible);
}

export async function browserClose(tabId: string): Promise<void> {
  domBrowserClose(tabId);
}

export async function browserCloseAll(): Promise<void> {
  domBrowserCloseAll();
}

export async function browserOpenDevtools(tabId: string): Promise<void> {
  domBrowserOpenDevtools(tabId);
}

/**
 * No-op on Electron for now — grab mode injects a guest picker script, which an
 * in-DOM `<webview>` needs a dedicated preload to host. Tauri grab is unaffected.
 * TODO: wire via a `<webview>` preload + `ipc-message` channel.
 */
export async function browserSetGrabMode(_tabId: string, _enabled: boolean): Promise<void> {}

/** Punchout layering — Tauri only. Electron's in-DOM overlay needs no layering. */
export async function browserSetBehind(_tabId: string, _behind: boolean): Promise<void> {}

export async function browserDetectBrowsers(): Promise<DetectedBrowser[]> {
  return platform.invoke("detect_installed_browsers");
}

/** Import cookies from `family` into the browser session; resolves to the count set. */
export async function browserImportCookies(family: string, host?: string): Promise<number> {
  return platform.invoke("browser_import_cookies", { family, host });
}

/** The `<webview>` element exposes real session history (canGoBack/goBack). */
export const browserHasNativeHistory = true;

/**
 * Electron uses an in-DOM `<webview>`, so DOM chrome overlays the page via
 * normal stacking — no punchout (Tauri) and no push-down needed.
 */
export const browserPunchoutOverlay = false;

export function onBrowserNav(handler: (event: BrowserNavEvent) => void): Promise<UnlistenFn> {
  return Promise.resolve(onDomBrowserNav(handler));
}

// One-time pump: target=_blank / window.open is denied+forwarded by the main
// process (setWindowOpenHandler) as `browser:new-window`; feed it to the DOM bus.
let newWindowPumpStarted = false;
function ensureNewWindowPump(): void {
  if (newWindowPumpStarted) return;
  newWindowPumpStarted = true;
  void platform.listen<{ url: string }>("browser:new-window", (payload) => {
    if (payload?.url) emitDomBrowserNewWindow({ openerTabId: "", url: payload.url });
  });
}

export function onBrowserNewWindow(
  handler: (event: BrowserNewWindowEvent) => void,
): Promise<UnlistenFn> {
  ensureNewWindowPump();
  return Promise.resolve(onDomBrowserNewWindow(handler));
}

export function onBrowserGrab(_handler: (event: BrowserGrabEvent) => void): Promise<UnlistenFn> {
  // Electron grab is not wired yet (see browserSetGrabMode); never fires.
  return Promise.resolve(() => {});
}

/**
 * Run find-in-page. Pass `findNext: false` to start/refresh a search for
 * `query`; pass `findNext: true` (with `forward`) to step between matches of the
 * same query. Results arrive via `onBrowserFind`.
 */
export async function browserFind(
  tabId: string,
  query: string,
  forward: boolean,
  findNext: boolean,
): Promise<void> {
  domBrowserFind(tabId, query, forward, findNext);
}

export async function browserStopFind(tabId: string): Promise<void> {
  domBrowserStopFind(tabId);
}

export function onBrowserFind(handler: (event: BrowserFindEvent) => void): Promise<UnlistenFn> {
  return Promise.resolve(onDomBrowserFind(handler));
}

/**
 * Fired when the user presses Cmd/Ctrl+F over the page; open the find bar.
 * Not wired for the in-DOM guest yet (needs a `<webview>` preload to catch the
 * keychord inside the page); the toolbar ⌘F path still works. Never fires today.
 */
export function onBrowserFindOpen(
  handler: (event: { tabId: string }) => void,
): Promise<UnlistenFn> {
  return Promise.resolve(onDomBrowserFindOpen(handler));
}

/** Fired when the guest resolves the page favicon. */
export function onBrowserFavicon(
  handler: (event: BrowserFaviconEvent) => void,
): Promise<UnlistenFn> {
  return Promise.resolve(onDomBrowserFavicon(handler));
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
  return platform.invoke<CreatePtyResult>("create_pty", { ...request });
}

export async function writePty(id: string, data: Uint8Array): Promise<void> {
  // The Uint8Array crosses the Electron IPC via structured clone (no number[]
  // boxing) and is re-wrapped as a Node Buffer in the main process.
  return platform.invoke("write_pty", { id, data });
}

export async function resizePty(id: string, cols: number, rows: number): Promise<void> {
  return platform.invoke("resize_pty", { id, cols, rows });
}

// Why: null when the session/pane is gone — a normal live-UI race, not an error.
export async function appliedPtySize(ptyId: string): Promise<AppliedPtySize | null> {
  const result = await platform.invoke<AppliedPtySize | string | null>("applied_pty_size", {
    id: ptyId,
  });
  // The NAPI method returns JSON; parse defensively so a main.ts that has not
  // yet registered the command in JSON_RESPONSE_COMMANDS still round-trips.
  if (typeof result === "string") {
    return JSON.parse(result) as AppliedPtySize | null;
  }
  return result;
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

// === DEV PERMISSIONS ===

export async function getDevPermissionsStatus(): Promise<DevPermissionState[]> {
  return platform.invoke<DevPermissionState[]>("dev_permissions_status");
}

export async function requestDevPermission(
  id: DevPermissionId,
): Promise<DevPermissionRequestResult> {
  return platform.invoke<DevPermissionRequestResult>("dev_permissions_request", { id });
}
