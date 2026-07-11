import { create } from "zustand";

export type RightPanelMode = "commits" | "file-browser";

interface RightPanelState {
  mode: RightPanelMode;
  setMode: (mode: RightPanelMode) => void;
}

export const useRightPanelStore = create<RightPanelState>((set) => ({
  mode: "commits",
  setMode: (mode) => set({ mode }),
}));
