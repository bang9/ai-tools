import { create } from "zustand";
import { unstable_batchedUpdates } from "react-dom";
import type { Project, Worktree, CloningProject } from "../types";
import * as tauri from "../lib/platform";
import { runCommand, runCommandSafely } from "../lib/command";
import { useTerminalStore } from "./terminal";
import { useBroadcastStore } from "./broadcast";
import { collectTerminalPanes } from "../lib/terminal-session";
import { useMissionStore } from "./mission";
import { overlay } from "../lib/overlay";
import { runTerminalGcNow } from "../lib/terminal-gc";

interface ProjectState {
  projects: Project[];
  cloningProjects: CloningProject[];
  selectedWorktree: Worktree | null;
  loading: boolean;
  projectsSnapshotRequestId: number;
  projectsMutationEpoch: number;

  loadProjects: () => Promise<void>;
  syncProjects: () => Promise<void>;
  refreshProject: (id: string) => Promise<Project>;
  startClone: (url: string) => Promise<void>;
  completeClone: (id: string, project: Project) => boolean;
  reorderProjects: (projectIds: string[]) => Promise<void>;
  removeProject: (id: string) => Promise<void>;
  addWorktree: (projectId: string, name: string) => Promise<Worktree>;
  addStackedWorktree: (projectId: string, parentName: string, name: string) => Promise<Worktree>;
  removeWorktree: (projectId: string, name: string) => Promise<void>;
  selectWorktree: (worktree: Worktree | null) => void;
  setWorktreeOrder: (projectId: string, order: string[]) => Promise<void>;
  renameProject: (projectId: string, name: string) => Promise<void>;
  setProjectCategory: (projectId: string, categoryId: string) => Promise<void>;
  setProjectFocus: (projectId: string, focused: boolean) => Promise<void>;
  remapDeletedProjectCategory: (categoryId: string) => void;
  setBaseBranch: (projectId: string, branch: string | null) => Promise<void>;
  toggleProjectCollapse: (id: string) => void;
}

function normalizeProjectUrl(url: string): string {
  return url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
}

function sameProjectIdentity(left: Project, right: Project): boolean {
  return (
    left.id === right.id ||
    left.sourcePath === right.sourcePath ||
    normalizeProjectUrl(left.url) === normalizeProjectUrl(right.url)
  );
}

function upsertProject(projects: Project[], project: Project): Project[] {
  let replaced = false;
  const nextProjects = projects.map((existing) => {
    if (sameProjectIdentity(existing, project)) {
      replaced = true;
      return project;
    }
    return existing;
  });

  return replaced ? nextProjects : [...nextProjects, project];
}

function sameWorktreeValue(left: Worktree, right: Worktree): boolean {
  return (
    left.path === right.path &&
    left.name === right.name &&
    left.branch === right.branch &&
    (left.stackParentName ?? null) === (right.stackParentName ?? null)
  );
}

function reconcileSelectedWorktree(
  projects: Project[],
  selectedWorktree: Worktree | null,
): Worktree | null {
  if (!selectedWorktree) {
    return null;
  }

  for (const project of projects) {
    if (project.sourcePath === selectedWorktree.path) {
      return selectedWorktree;
    }
    const match = project.worktrees.find((worktree) => worktree.path === selectedWorktree.path);
    if (match) {
      return sameWorktreeValue(match, selectedWorktree) ? selectedWorktree : match;
    }
  }

  return null;
}

function upsertWorktree(worktrees: Worktree[], worktree: Worktree): Worktree[] {
  const index = worktrees.findIndex((existing) => existing.name === worktree.name);
  if (index === -1) {
    return [...worktrees, worktree];
  }
  const next = worktrees.slice();
  next[index] = worktree;
  return next;
}

function reorderWorktrees(worktrees: Worktree[], order: string[]): Worktree[] {
  const ordered: Worktree[] = [];
  const remaining = [...worktrees];
  for (const name of order) {
    const idx = remaining.findIndex((wt) => wt.name === name);
    if (idx !== -1) ordered.push(...remaining.splice(idx, 1));
  }
  return [...ordered, ...remaining];
}

function sourceWorktreeForProject(project: Project): Worktree {
  return {
    name: "source",
    path: project.sourcePath,
    branch: "main",
    stackParentName: null,
  };
}

interface ProjectsSnapshotToken {
  requestId: number;
  mutationEpoch: number;
}

type ProjectStateSetter = (
  partial:
    | ProjectState
    | Partial<ProjectState>
    | ((state: ProjectState) => ProjectState | Partial<ProjectState>),
) => void;

function beginProjectsSnapshotRequest(
  get: () => ProjectState,
  set: ProjectStateSetter,
  options?: { loading?: boolean },
): ProjectsSnapshotToken {
  const requestId = get().projectsSnapshotRequestId + 1;
  const mutationEpoch = get().projectsMutationEpoch;

  set({
    projectsSnapshotRequestId: requestId,
    ...(options?.loading ? { loading: true } : {}),
  });

  return { requestId, mutationEpoch };
}

function canApplyProjectsSnapshot(state: ProjectState, token: ProjectsSnapshotToken): boolean {
  return (
    state.projectsSnapshotRequestId === token.requestId &&
    state.projectsMutationEpoch === token.mutationEpoch
  );
}

function applyProjectsSnapshot(
  set: ProjectStateSetter,
  token: ProjectsSnapshotToken,
  updater: (state: ProjectState) => Partial<ProjectState>,
) {
  set((state) => {
    if (!canApplyProjectsSnapshot(state, token)) {
      return {};
    }
    return updater(state);
  });
}

function finishProjectsSnapshotLoad(set: ProjectStateSetter, token: ProjectsSnapshotToken) {
  set((state) => (state.projectsSnapshotRequestId === token.requestId ? { loading: false } : {}));
}

function commitProjectMutation(
  set: ProjectStateSetter,
  updater: (state: ProjectState) => Partial<ProjectState>,
) {
  set((state) => ({
    ...updater(state),
    projectsMutationEpoch: state.projectsMutationEpoch + 1,
  }));
}

function markProjectMutationStarted(set: ProjectStateSetter) {
  set((state) => ({
    projectsMutationEpoch: state.projectsMutationEpoch + 1,
  }));
}

export const useProjectStore = create<ProjectState>((set) => ({
  projects: [],
  cloningProjects: [],
  selectedWorktree: null,
  loading: false,
  projectsSnapshotRequestId: 0,
  projectsMutationEpoch: 0,

  loadProjects: async () => {
    const token = beginProjectsSnapshotRequest(useProjectStore.getState, set, {
      loading: true,
    });
    try {
      const projects = await runCommandSafely(() => tauri.listProjects(), {
        errorToast: "Failed to load projects",
      });
      if (projects) {
        applyProjectsSnapshot(set, token, (state) => ({
          projects,
          selectedWorktree: reconcileSelectedWorktree(projects, state.selectedWorktree),
        }));
      }
    } finally {
      finishProjectsSnapshotLoad(set, token);
    }
  },

  syncProjects: async () => {
    const token = beginProjectsSnapshotRequest(useProjectStore.getState, set);
    const projects = await runCommandSafely(() => tauri.listProjects(), {
      errorToast: false,
    });
    if (projects) {
      applyProjectsSnapshot(set, token, (state) => ({
        projects,
        selectedWorktree: reconcileSelectedWorktree(projects, state.selectedWorktree),
      }));
    }
  },

  refreshProject: async (id: string) => {
    const token = beginProjectsSnapshotRequest(useProjectStore.getState, set);
    const project = await runCommand(() => tauri.refreshProject(id), {
      errorToast: "Failed to refresh project",
    });
    applyProjectsSnapshot(set, token, (state) => {
      const projects = upsertProject(state.projects, project);
      return {
        projects,
        selectedWorktree: reconcileSelectedWorktree(projects, state.selectedWorktree),
      };
    });
    return project;
  },

  startClone: async (url: string) => {
    const result = await runCommand(() => tauri.startClone(url), {
      errorToast: "Failed to start clone",
    });

    if (result.type === "alreadyExists") {
      const { type: _, ...project } = result;
      commitProjectMutation(set, (state) => ({
        projects: upsertProject(state.projects, project),
      }));
      return;
    }

    const { type: __, ...cloning } = result;
    set((state) => ({
      cloningProjects: [...state.cloningProjects, cloning],
    }));
  },

  completeClone: (id, project) => {
    const { cloningProjects } = useProjectStore.getState();
    if (!cloningProjects.some((cloning) => cloning.id === id)) {
      return false;
    }

    commitProjectMutation(set, (state) => ({
      cloningProjects: state.cloningProjects.filter((cloning) => cloning.id !== id),
      projects: upsertProject(state.projects, project),
    }));
    return true;
  },

  reorderProjects: async (projectIds: string[]) => {
    commitProjectMutation(set, (state) => {
      const projectMap = new Map(state.projects.map((p) => [p.id, p]));
      const reordered = projectIds
        .map((id) => projectMap.get(id))
        .filter((p): p is Project => p != null);
      return { projects: reordered };
    });
    await runCommandSafely(() => tauri.reorderProjects(projectIds), {
      errorToast: false,
    });
  },

  removeProject: async (id: string) => {
    // Check for mission references BEFORE deleting
    const { missions } = useMissionStore.getState();
    const referencingMissions = missions.filter((m) => m.projects.some((p) => p.projectId === id));

    if (referencingMissions.length > 0) {
      const missionNames = referencingMissions.map((m) => m.name).join("\n  - ");
      const confirmed = await overlay.confirm({
        title: "Remove project from missions too?",
        description: `This project is used in the following missions:\n  - ${missionNames}\n\nDelete will also remove it from these missions.`,
        confirmLabel: "Delete project",
        variant: "destructive",
      });
      if (!confirmed) throw new Error("Cancelled");

      // Clean up mission references first (before SOT deletion)
      for (const mission of referencingMissions) {
        await useMissionStore.getState().removeProject(mission.id, id);
        // If mission now has 0 projects, delete it entirely
        const updated = useMissionStore.getState().missions.find((m) => m.id === mission.id);
        if (updated && updated.projects.length === 0) {
          await useMissionStore.getState().deleteMission(mission.id);
        }
      }
    }

    // Proceed with project deletion
    markProjectMutationStarted(set);
    await runCommand(() => tauri.removeProject(id), {
      errorToast: "Failed to remove project",
    });
    commitProjectMutation(set, (state) => {
      const projects = state.projects.filter((p) => p.id !== id);
      return {
        projects,
        selectedWorktree: reconcileSelectedWorktree(projects, state.selectedWorktree),
      };
    });
    void runTerminalGcNow();
  },

  addWorktree: async (projectId: string, name: string) => {
    markProjectMutationStarted(set);
    const worktree = await runCommand(
      async () => {
        const { projects } = useProjectStore.getState();
        const project = projects.find((p) => p.id === projectId);
        if (project?.worktrees.some((w) => w.name === name)) {
          throw new Error(`Worktree '${name}' already exists`);
        }

        return tauri.addWorktree(projectId, name, name);
      },
      {
        errorToast: "Failed to create worktree",
      },
    );
    commitProjectMutation(set, (state) => ({
      projects: state.projects.map((p) =>
        p.id === projectId ? { ...p, worktrees: upsertWorktree(p.worktrees, worktree) } : p,
      ),
    }));
    return worktree;
  },

  addStackedWorktree: async (projectId: string, parentName: string, name: string) => {
    markProjectMutationStarted(set);
    const worktree = await runCommand(
      async () => {
        const { projects } = useProjectStore.getState();
        const project = projects.find((p) => p.id === projectId);
        if (project?.worktrees.some((w) => w.name === name)) {
          throw new Error(`Worktree '${name}' already exists`);
        }

        return tauri.addStackedWorktree(projectId, parentName, name);
      },
      {
        errorToast: "Failed to create stacked worktree",
      },
    );
    commitProjectMutation(set, (state) => ({
      projects: state.projects.map((p) =>
        p.id === projectId ? { ...p, worktrees: upsertWorktree(p.worktrees, worktree) } : p,
      ),
    }));
    return worktree;
  },

  removeWorktree: async (projectId: string, name: string) => {
    markProjectMutationStarted(set);
    const project = useProjectStore.getState().projects.find((p) => p.id === projectId);
    const removedWorktree = project?.worktrees.find((w) => w.name === name);
    const worktreePath = removedWorktree?.path;

    await runCommand(() => tauri.removeWorktree(projectId, name), {
      errorToast: "Failed to remove worktree",
    });

    const currentState = useProjectStore.getState();
    const nextProjects = currentState.projects.map((p) =>
      p.id === projectId ? { ...p, worktrees: p.worktrees.filter((w) => w.name !== name) } : p,
    );
    const nextProject = nextProjects.find((p) => p.id === projectId);
    const removedSelected =
      currentState.selectedWorktree != null && currentState.selectedWorktree.path === worktreePath;
    const nextSelectedWorktree =
      removedSelected && nextProject
        ? sourceWorktreeForProject(nextProject)
        : reconcileSelectedWorktree(nextProjects, currentState.selectedWorktree);

    unstable_batchedUpdates(() => {
      if (worktreePath) {
        const removedSession = useTerminalStore.getState().sessions[worktreePath];
        const broadcastStore = useBroadcastStore.getState();
        broadcastStore.stopPip(worktreePath);
        if (removedSession) {
          for (const pane of collectTerminalPanes(removedSession)) {
            if (pane.ptyId) {
              broadcastStore.stopMirror(pane.ptyId);
              broadcastStore.stopPipByPty(pane.ptyId);
            }
          }
        }
        useTerminalStore.getState().removeSession(worktreePath, nextSelectedWorktree?.path ?? null);
      }

      commitProjectMutation(set, () => ({
        projects: nextProjects,
        selectedWorktree: nextSelectedWorktree,
      }));
    });
    void runTerminalGcNow();
  },

  selectWorktree: (worktree: Worktree | null) => {
    set({ selectedWorktree: worktree });
  },

  // Phase 2: 드래그 재정렬 완료 시 호출. 순서를 config에 저장하고 즉시 UI에 반영.
  setWorktreeOrder: async (projectId: string, order: string[]) => {
    markProjectMutationStarted(set);
    await runCommand(() => tauri.setWorktreeOrder(projectId, order), {
      errorToast: "Failed to save worktree order",
    });
    commitProjectMutation(set, (state) => ({
      projects: state.projects.map((p) =>
        p.id === projectId ? { ...p, worktrees: reorderWorktrees(p.worktrees, order) } : p,
      ),
    }));
  },

  renameProject: async (projectId: string, name: string) => {
    markProjectMutationStarted(set);
    await runCommand(() => tauri.renameProject(projectId, name), {
      errorToast: "Failed to rename project",
    });
    commitProjectMutation(set, (state) => ({
      projects: state.projects.map((p) => (p.id === projectId ? { ...p, name } : p)),
    }));
  },

  setProjectCategory: async (projectId: string, categoryId: string) => {
    markProjectMutationStarted(set);
    await runCommand(() => tauri.setProjectCategory(projectId, categoryId), {
      errorToast: "Failed to set project category",
    });
    commitProjectMutation(set, (state) => ({
      projects: state.projects.map((p) => (p.id === projectId ? { ...p, categoryId } : p)),
    }));
  },

  setProjectFocus: async (projectId: string, focused: boolean) => {
    markProjectMutationStarted(set);
    await runCommand(() => tauri.setProjectFocus(projectId, focused), {
      errorToast: "Failed to update project focus",
    });
    commitProjectMutation(set, (state) => ({
      projects: state.projects.map((p) => (p.id === projectId ? { ...p, focused } : p)),
    }));
  },

  remapDeletedProjectCategory: (categoryId: string) => {
    commitProjectMutation(set, (state) => ({
      projects: state.projects.map((project) =>
        project.categoryId === categoryId ? { ...project, categoryId: "default" } : project,
      ),
    }));
  },

  setBaseBranch: async (projectId: string, branch: string | null) => {
    markProjectMutationStarted(set);
    await runCommand(() => tauri.setBaseBranch(projectId, branch), {
      errorToast: "Failed to set base branch",
    });
    commitProjectMutation(set, (state) => ({
      projects: state.projects.map((p) => (p.id === projectId ? { ...p, baseBranch: branch } : p)),
    }));
  },

  toggleProjectCollapse: (id: string) => {
    const project = useProjectStore.getState().projects.find((p) => p.id === id);
    if (!project) return;
    const collapsed = !project.collapsed;
    commitProjectMutation(set, (state) => ({
      projects: state.projects.map((p) => (p.id === id ? { ...p, collapsed } : p)),
    }));
    tauri.setProjectCollapsed(id, collapsed).catch(() => {});
  },
}));
