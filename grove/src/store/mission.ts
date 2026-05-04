import { create } from "zustand";
import type { Mission } from "../types";
import * as tauri from "../lib/platform";
import { runCommand, runCommandSafely } from "../lib/command";
import { useTerminalStore } from "./terminal";
import { runTerminalGcNow } from "../lib/terminal-gc";

interface MissionState {
  missions: Mission[];
  selectedItem: { missionId: string; projectId?: string } | null;
  deletingMissions: Record<string, boolean>;
  deletingMissionProjects: Record<string, boolean>;
  loading: boolean;

  loadMissions: () => Promise<void>;
  createMission: (name: string, branchName?: string | null) => Promise<Mission>;
  deleteMission: (id: string) => Promise<void>;
  addProject: (missionId: string, projectId: string) => Promise<void>;
  removeProject: (missionId: string, projectId: string) => Promise<void>;
  selectItem: (missionId: string, projectId?: string) => void;
  toggleCollapse: (missionId: string) => void;
  getSelectedPath: () => string | null;
}

export const useMissionStore = create<MissionState>((set, get) => ({
  missions: [],
  selectedItem: null,
  deletingMissions: {},
  deletingMissionProjects: {},
  loading: false,

  loadMissions: async () => {
    set({ loading: true });
    try {
      const missions = await runCommandSafely(() => tauri.listMissions(), {
        errorToast: "Failed to load missions",
      });
      if (missions) {
        set({ missions });
      }
    } finally {
      set({ loading: false });
    }
  },

  createMission: async (name: string, branchName?: string | null) => {
    const mission = await runCommand(
      () => tauri.createMission(name, branchName),
      {
        errorToast: "Failed to create mission",
      },
    );
    set((state) => ({ missions: [...state.missions, mission] }));
    return mission;
  },

  deleteMission: async (id: string) => {
      set((state) => ({
        deletingMissions: { ...state.deletingMissions, [id]: true },
        deletingMissionProjects: {
          ...state.deletingMissionProjects,
          ...Object.fromEntries(
            (state.missions.find((mission) => mission.id === id)?.projects ?? []).map(
              (project) => [`${id}:${project.projectId}`, true],
            ),
          ),
        },
      }));

    try {
      const mission = get().missions.find((m) => m.id === id);
      if (mission) {
        useTerminalStore.getState().removeSession(mission.missionDir);
        for (const project of mission.projects) {
          useTerminalStore.getState().removeSession(project.path);
        }
      }

      await runCommand(() => tauri.deleteMission(id), {
        errorToast: "Failed to delete mission",
      });

      set((state) => {
        const { [id]: _, ...remainingDeleting } = state.deletingMissions;
        const remainingDeletingProjects = Object.fromEntries(
          Object.entries(state.deletingMissionProjects).filter(
            ([key]) => !key.startsWith(`${id}:`),
          ),
        );
        const nextSelected =
          state.selectedItem?.missionId === id ? null : state.selectedItem;
        return {
          missions: state.missions.filter((m) => m.id !== id),
          selectedItem: nextSelected,
          deletingMissions: remainingDeleting,
          deletingMissionProjects: remainingDeletingProjects,
        };
      });
      void runTerminalGcNow();
    } catch (error) {
      set((state) => {
        const { [id]: _, ...remainingDeleting } = state.deletingMissions;
        const remainingDeletingProjects = Object.fromEntries(
          Object.entries(state.deletingMissionProjects).filter(
            ([key]) => !key.startsWith(`${id}:`),
          ),
        );
        return {
          deletingMissions: remainingDeleting,
          deletingMissionProjects: remainingDeletingProjects,
        };
      });
      throw error;
    }
  },

  addProject: async (missionId: string, projectId: string) => {
    const missionProject = await runCommand(
      () => tauri.addProjectToMission(missionId, projectId),
      { errorToast: "Failed to add project to mission" },
    );
    set((state) => ({
      missions: state.missions.map((m) =>
        m.id === missionId
          ? { ...m, projects: [...m.projects, missionProject] }
          : m,
      ),
    }));
  },

  removeProject: async (missionId: string, projectId: string) => {
    const deletionKey = `${missionId}:${projectId}`;
    const mission = get().missions.find((m) => m.id === missionId);
    const removedProject = mission?.projects.find(
      (p) => p.projectId === projectId,
    );
    const wasSelected =
      get().selectedItem?.missionId === missionId &&
      get().selectedItem?.projectId === projectId;
    const nextActiveWorktree = wasSelected
      ? (mission?.missionDir ?? null)
      : null;

    set((state) => ({
      deletingMissionProjects: {
        ...state.deletingMissionProjects,
        [deletionKey]: true,
      },
    }));

    try {
      if (removedProject) {
        useTerminalStore
          .getState()
          .removeSession(removedProject.path, nextActiveWorktree);
      }

      await runCommand(
        () => tauri.removeProjectFromMission(missionId, projectId),
        { errorToast: "Failed to remove project from mission" },
      );

      set((state) => {
        const nextMissions = state.missions.map((m) =>
          m.id === missionId
            ? { ...m, projects: m.projects.filter((p) => p.projectId !== projectId) }
            : m,
        );

        const shouldFallbackSelection =
          state.selectedItem?.missionId === missionId &&
          state.selectedItem?.projectId === projectId;
        const nextSelected = shouldFallbackSelection
          ? { missionId }
          : state.selectedItem;
        const { [deletionKey]: _, ...remainingDeletingProjects } =
          state.deletingMissionProjects;

        return {
          missions: nextMissions,
          selectedItem: nextSelected,
          deletingMissionProjects: remainingDeletingProjects,
        };
      });
      void runTerminalGcNow();
    } catch (error) {
      set((state) => {
        const { [deletionKey]: _, ...remainingDeletingProjects } =
          state.deletingMissionProjects;
        return { deletingMissionProjects: remainingDeletingProjects };
      });
      throw error;
    }
  },

  selectItem: (missionId: string, projectId?: string) => {
    set({
      selectedItem: projectId ? { missionId, projectId } : { missionId },
    });
  },

  toggleCollapse: (missionId: string) => {
    const mission = get().missions.find((m) => m.id === missionId);
    if (!mission) return;
    const collapsed = !mission.collapsed;
    set((state) => ({
      missions: state.missions.map((m) =>
        m.id === missionId ? { ...m, collapsed } : m,
      ),
    }));
    tauri.setMissionCollapsed(missionId, collapsed).catch(() => {});
  },

  getSelectedPath: () => {
    const { selectedItem, missions } = get();
    if (!selectedItem) return null;

    const mission = missions.find((m) => m.id === selectedItem.missionId);
    if (!mission) return null;

    if (selectedItem.projectId) {
      const project = mission.projects.find(
        (p) => p.projectId === selectedItem.projectId,
      );
      return project?.path ?? null;
    }

    return mission.missionDir;
  },
}));
