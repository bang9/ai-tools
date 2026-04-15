import { useEffect } from "react";
import { useProjectStore } from "../store/project";
import { registerSyncJob, startSyncManager, stopSyncManager } from "../lib/sync-manager";
import { disposeDiffSync, initDiffSync } from "../lib/diff-sync";
import { useToastStore } from "../store/toast";
import { TERMINAL_GC_INTERVAL_MS, TERMINAL_GC_JOB_KEY, runTerminalGcNow } from "../lib/terminal-gc";
import * as tauri from "../lib/platform";

export function useProject() {
  const projects = useProjectStore((state) => state.projects);
  const cloningProjects = useProjectStore((state) => state.cloningProjects);
  const loading = useProjectStore((state) => state.loading);
  const loadProjects = useProjectStore((state) => state.loadProjects);

  useEffect(() => {
    registerSyncJob(
      "projects",
      () => useProjectStore.getState().syncProjects(),
      10_000,
    );
    registerSyncJob(
      TERMINAL_GC_JOB_KEY,
      async () => {
        await runTerminalGcNow();
      },
      TERMINAL_GC_INTERVAL_MS,
    );

    initDiffSync();

    // Initial load (blocking for first render)
    loadProjects().then(() => {
      startSyncManager({ runImmediately: false });
    });

    return () => {
      disposeDiffSync();
      stopSyncManager();
    };
  }, []);

  // Clone event listeners
  useEffect(() => {
    let cancelled = false;
    const cleanups: (() => void)[] = [];

    tauri.onCloneCompleted(({ id, project }) => {
      if (cancelled) return;
      const completed = useProjectStore.getState().completeClone(id, project);
      if (!completed) return;
      useToastStore.getState().addToast("success", "Project cloned successfully");
    }).then((fn) => {
      if (cancelled) fn();
      else cleanups.push(fn);
    });

    tauri.onCloneFailed(({ id, error }) => {
      if (cancelled) return;
      const { cloningProjects } = useProjectStore.getState();
      if (!cloningProjects.some((c) => c.id === id)) return;

      useProjectStore.setState((state) => ({
        cloningProjects: state.cloningProjects.filter((c) => c.id !== id),
      }));
      useToastStore.getState().addToast("error", `Clone failed: ${error}`);
    }).then((fn) => {
      if (cancelled) fn();
      else cleanups.push(fn);
    });

    return () => {
      cancelled = true;
      cleanups.forEach((fn) => fn());
    };
  }, []);

  return { projects, cloningProjects, loading };
}
