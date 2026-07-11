import { useDiffStore } from "../store/diff";
import { registerSyncJob, runJobNow, unregisterSyncJob } from "./sync-manager";

export const DIFF_STATUS_JOB_KEY = "diff-status";
export const DIFF_COMMITS_JOB_KEY = "diff-commits";

const STATUS_INTERVAL_MS = 2_000;
const COMMITS_INTERVAL_MS = 10_000;

let focusHandler: (() => void) | null = null;

async function runStatusJob() {
  const state = useDiffStore.getState();
  if (!state.worktreePath) return;
  const before = state.fileStatuses;
  await state.loadStatus();
  const after = useDiffStore.getState();
  // loadStatus skips `set()` when content is unchanged, so a fresh array
  // reference means the file list actually changed on disk. Keep the diff
  // viewer in sync with the new list if a file is currently selected.
  if (after.fileStatuses !== before && after.selectedFile && after.selectedView === "changes") {
    await after.loadWorkingDiff(after.selectedFile, after.isViewingStaged);
  }
}

async function runCommitsJob() {
  const state = useDiffStore.getState();
  if (!state.worktreePath) return;
  await Promise.all([state.loadCommits(), state.loadBehindCount()]);
}

/**
 * Register app-level polling jobs for diff state and wire a window-focus
 * listener that fires both jobs immediately on refocus.
 *
 * sync-manager's per-job `running` flag dedups focus-driven runs against
 * any in-flight polling run, so focus + polling never stack.
 */
export function initDiffSync() {
  registerSyncJob(DIFF_STATUS_JOB_KEY, runStatusJob, STATUS_INTERVAL_MS);
  registerSyncJob(DIFF_COMMITS_JOB_KEY, runCommitsJob, COMMITS_INTERVAL_MS);

  focusHandler = () => {
    runJobNow(DIFF_STATUS_JOB_KEY);
    runJobNow(DIFF_COMMITS_JOB_KEY);
  };
  window.addEventListener("focus", focusHandler);
}

export function disposeDiffSync() {
  unregisterSyncJob(DIFF_STATUS_JOB_KEY);
  unregisterSyncJob(DIFF_COMMITS_JOB_KEY);
  if (focusHandler) {
    window.removeEventListener("focus", focusHandler);
    focusHandler = null;
  }
}
