import { create } from "zustand";

export type PreferencesTabId =
  | "general"
  | "categories"
  | "terminal"
  | "browser"
  | "developer"
  | "permissions";

interface PreferencesUiState {
  open: boolean;
  activeTab: PreferencesTabId;
  openPreferences: (tab?: PreferencesTabId) => void;
  closePreferences: () => void;
  setActiveTab: (tab: PreferencesTabId) => void;
}

export const usePreferencesUiStore = create<PreferencesUiState>((set) => ({
  open: false,
  activeTab: "general",

  openPreferences: (tab = "general") => {
    set({ open: true, activeTab: tab });
  },

  closePreferences: () => {
    set({ open: false });
  },

  setActiveTab: (tab) => {
    set({ activeTab: tab });
  },
}));
