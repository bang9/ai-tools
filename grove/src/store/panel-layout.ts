import { create } from "zustand";
import { savePanelLayouts, loadPanelLayouts } from "../lib/platform";

export interface GlobalTerminalTab {
  id: string;
  paneId: string;
  title: string;
  /** When set, this tab mirrors an existing PTY instead of spawning a new one */
  mirrorPtyId?: string;
  /** Override cwd for this tab (defaults to baseDir when omitted) */
  cwd?: string;
}

interface GlobalTerminalLayout {
  collapsed: boolean;
  ratio: number;
  tabs: GlobalTerminalTab[];
  activeTabId: string;
}

interface PanelLayouts {
  main: number[];
  diff: number[];
  changes: number[];
  pipWidth: number;
  globalTerminal: GlobalTerminalLayout;
  sidebarMode: "projects" | "missions";
}

interface PanelLayoutStore {
  main: number[];
  diff: number[];
  changes: number[];
  pipWidth: number;
  globalTerminal: GlobalTerminalLayout;
  sidebarMode: "projects" | "missions";
  loaded: boolean;
  init: () => Promise<void>;
  updateMain: (ratios: number[]) => void;
  updateDiff: (ratios: number[]) => void;
  updateChanges: (ratios: number[]) => void;
  updatePipWidth: (width: number) => void;
  updateGlobalTerminal: (layout: Partial<GlobalTerminalLayout>) => void;
  addGlobalTerminalTab: (opts?: { title?: string; cwd?: string }) => GlobalTerminalTab;
  addGlobalTerminalMirrorTab: (title: string, ptyId: string) => GlobalTerminalTab;
  removeGlobalTerminalTab: (tabId: string) => void;
  setActiveGlobalTerminalTab: (tabId: string) => void;
  switchGlobalTerminalTab: (direction: "next" | "prev") => void;
  setSidebarMode: (mode: "projects" | "missions") => void;
}

const DEFAULTS: PanelLayouts = {
  main: [0.2, 0.65, 0.15],
  diff: [0.3, 0.2, 0.5],
  changes: [0.35, 0.65],
  pipWidth: 360,
  globalTerminal: { collapsed: true, ratio: 0.3, tabs: [], activeTabId: "" },
  sidebarMode: "projects" as const,
};

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function debouncedSave(layouts: PanelLayouts) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    // Strip mirror tabs from persistence — they're ephemeral
    const gt = layouts.globalTerminal;
    const cleanGt = {
      ...gt,
      tabs: gt.tabs.filter((t) => !t.mirrorPtyId),
    };
    savePanelLayouts(JSON.stringify({ ...layouts, globalTerminal: cleanGt })).catch(() => {});
  }, 500);
}

function getFullLayouts(get: () => PanelLayoutStore): PanelLayouts {
  return {
    main: get().main,
    diff: get().diff,
    changes: get().changes,
    pipWidth: get().pipWidth,
    globalTerminal: get().globalTerminal,
    sidebarMode: get().sidebarMode,
  };
}

// Accept legacy shape with optional paneId
interface LegacyGlobalTerminalLayout {
  collapsed?: boolean;
  ratio?: number;
  paneId?: string;
  tabs?: GlobalTerminalTab[];
  activeTabId?: string;
}

function makeDefaultTab(): GlobalTerminalTab {
  return { id: crypto.randomUUID(), paneId: crypto.randomUUID(), title: "Terminal 1" };
}

function resolveGlobalTerminalLayout(layout?: LegacyGlobalTerminalLayout): GlobalTerminalLayout {
  const collapsed = layout?.collapsed ?? DEFAULTS.globalTerminal.collapsed;
  const ratio = layout?.ratio ?? DEFAULTS.globalTerminal.ratio;

  // Collect tabs: legacy single paneId, persisted tabs, or fresh default
  const rawTabs =
    layout?.paneId && !layout.tabs?.length
      ? [{ id: crypto.randomUUID(), paneId: layout.paneId, title: "Terminal 1" }]
      : layout?.tabs?.filter((t) => !t.mirrorPtyId);

  const tabs = rawTabs?.length ? rawTabs : [makeDefaultTab()];
  const activeTabId =
    layout?.activeTabId && tabs.some((t) => t.id === layout.activeTabId)
      ? layout.activeTabId
      : tabs[0].id;

  return { collapsed, ratio, tabs, activeTabId };
}

function resolvePanelLayouts(parsed?: Partial<PanelLayouts>): PanelLayouts {
  // Ensure main ratios match expected pane count (3)
  const main = parsed?.main?.length === 3 ? parsed.main : DEFAULTS.main;
  return {
    main,
    diff: parsed?.diff ?? DEFAULTS.diff,
    changes: parsed?.changes ?? DEFAULTS.changes,
    pipWidth: parsed?.pipWidth ?? DEFAULTS.pipWidth,
    globalTerminal: resolveGlobalTerminalLayout(
      parsed?.globalTerminal as LegacyGlobalTerminalLayout | undefined,
    ),
    sidebarMode: parsed?.sidebarMode ?? DEFAULTS.sidebarMode,
  };
}

export const usePanelLayoutStore = create<PanelLayoutStore>((set, get) => ({
  main: DEFAULTS.main,
  diff: DEFAULTS.diff,
  changes: DEFAULTS.changes,
  pipWidth: DEFAULTS.pipWidth,
  globalTerminal: resolveGlobalTerminalLayout(DEFAULTS.globalTerminal),
  sidebarMode: DEFAULTS.sidebarMode,
  loaded: false,

  init: async () => {
    try {
      const raw = await loadPanelLayouts();
      const parsed = JSON.parse(raw) as Partial<PanelLayouts>;
      const resolved = resolvePanelLayouts(parsed);
      set({ ...resolved, loaded: true });
      debouncedSave(resolved);
    } catch {
      const resolved = resolvePanelLayouts();
      set({ ...resolved, loaded: true });
      debouncedSave(resolved);
    }
  },

  updateMain: (ratios) => {
    set({ main: ratios });
    debouncedSave({ ...getFullLayouts(get), main: ratios });
  },

  updateDiff: (ratios) => {
    set({ diff: ratios });
    debouncedSave({ ...getFullLayouts(get), diff: ratios });
  },

  updateChanges: (ratios) => {
    set({ changes: ratios });
    debouncedSave({ ...getFullLayouts(get), changes: ratios });
  },

  updatePipWidth: (width) => {
    set({ pipWidth: width });
    debouncedSave({ ...getFullLayouts(get), pipWidth: width });
  },

  updateGlobalTerminal: (layout) => {
    const updated = { ...get().globalTerminal, ...layout };
    set({ globalTerminal: updated });
    debouncedSave({ ...getFullLayouts(get), globalTerminal: updated });
  },

  addGlobalTerminalTab: (opts?: { title?: string; cwd?: string }) => {
    const gt = get().globalTerminal;
    const maxNum = gt.tabs.reduce((max, t) => {
      const m = t.title.match(/^Terminal (\d+)$/);
      return m ? Math.max(max, parseInt(m[1], 10)) : max;
    }, 0);
    const tab: GlobalTerminalTab = {
      id: crypto.randomUUID(),
      paneId: crypto.randomUUID(),
      title: opts?.title ?? `Terminal ${maxNum + 1}`,
      cwd: opts?.cwd,
    };
    const updated: GlobalTerminalLayout = {
      ...gt,
      tabs: [...gt.tabs, tab],
      activeTabId: tab.id,
    };
    set({ globalTerminal: updated });
    debouncedSave({ ...getFullLayouts(get), globalTerminal: updated });
    return tab;
  },

  addGlobalTerminalMirrorTab: (title, ptyId) => {
    const gt = get().globalTerminal;
    // If a mirror for this ptyId already exists, just activate it
    const existing = gt.tabs.find((t) => t.mirrorPtyId === ptyId);
    if (existing) {
      const updated: GlobalTerminalLayout = {
        ...gt,
        activeTabId: existing.id,
      };
      set({ globalTerminal: updated });
      debouncedSave({ ...getFullLayouts(get), globalTerminal: updated });
      return existing;
    }
    const tab: GlobalTerminalTab = {
      id: crypto.randomUUID(),
      paneId: crypto.randomUUID(),
      title,
      mirrorPtyId: ptyId,
    };
    const updated: GlobalTerminalLayout = {
      ...gt,
      tabs: [...gt.tabs, tab],
      activeTabId: tab.id,
    };
    set({ globalTerminal: updated });
    debouncedSave({ ...getFullLayouts(get), globalTerminal: updated });
    return tab;
  },

  removeGlobalTerminalTab: (tabId) => {
    const gt = get().globalTerminal;
    if (gt.tabs.length <= 1) return;
    const idx = gt.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    const newTabs = gt.tabs.filter((t) => t.id !== tabId);
    const newActiveId =
      gt.activeTabId === tabId ? newTabs[Math.max(0, idx - 1)].id : gt.activeTabId;
    const updated: GlobalTerminalLayout = {
      ...gt,
      tabs: newTabs,
      activeTabId: newActiveId,
    };
    set({ globalTerminal: updated });
    debouncedSave({ ...getFullLayouts(get), globalTerminal: updated });
  },

  setActiveGlobalTerminalTab: (tabId) => {
    const gt = get().globalTerminal;
    if (!gt.tabs.some((t) => t.id === tabId)) return;
    const updated: GlobalTerminalLayout = { ...gt, activeTabId: tabId };
    set({ globalTerminal: updated });
    debouncedSave({ ...getFullLayouts(get), globalTerminal: updated });
  },

  switchGlobalTerminalTab: (direction) => {
    const gt = get().globalTerminal;
    if (gt.tabs.length <= 1) return;
    const idx = gt.tabs.findIndex((t) => t.id === gt.activeTabId);
    const nextIdx =
      direction === "next"
        ? (idx + 1) % gt.tabs.length
        : (idx - 1 + gt.tabs.length) % gt.tabs.length;
    const updated: GlobalTerminalLayout = {
      ...gt,
      activeTabId: gt.tabs[nextIdx].id,
    };
    set({ globalTerminal: updated });
    debouncedSave({ ...getFullLayouts(get), globalTerminal: updated });
  },

  setSidebarMode: (mode) => {
    set({ sidebarMode: mode });
    debouncedSave({ ...getFullLayouts(get), sidebarMode: mode });
  },
}));
