import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTerminalStore } from "../store/terminal";
import { usePanelLayoutStore, type GlobalTerminalTab } from "../store/panel-layout";
import { closePty as ipcClosePty, createPty as ipcCreatePty, getAppConfig } from "../lib/platform";
import { useBroadcastStore } from "../store/broadcast";
import { runCommand, runCommandSafely } from "../lib/command";
import { log, error as logError } from "../lib/logger";
import { restoreBroadcastSessionSize } from "../lib/broadcast-session";

interface TabPtyState {
  ptyId: string;
  ready: boolean;
  mirror: boolean;
}

export function useGlobalTerminal() {
  const theme = useTerminalStore((s) => s.theme);
  const tabs = usePanelLayoutStore(useShallow((s) => s.globalTerminal.tabs));
  const activeTabId = usePanelLayoutStore((s) => s.globalTerminal.activeTabId);

  const tabPtyMapRef = useRef(new Map<string, TabPtyState>());
  const pendingRef = useRef(new Set<string>());
  const [tabPtyMap, setTabPtyMap] = useState<Map<string, TabPtyState>>(new Map());

  const createPtyForTab = useCallback(
    async (tab: GlobalTerminalTab) => {
      if (!theme) return;
      if (pendingRef.current.has(tab.id)) return;
      pendingRef.current.add(tab.id);

      const ptyId = crypto.randomUUID();

      log("global-terminal", "creating pty for tab", {
        tabId: tab.id,
        paneId: tab.paneId,
        ptyId,
      });

      try {
        const config = await runCommand(() => getAppConfig(), {
          errorToast: false,
        });

        const cwd = tab.cwd ?? config.baseDir;
        await runCommand(
          () =>
            ipcCreatePty({
              ptyId,
              paneId: tab.paneId,
              worktreePath: cwd,
              cwd,
              cols: 80,
              rows: 24,
            }),
          { errorToast: false },
        );

        // Tab may have been removed while PTY was being created
        const currentTabs = usePanelLayoutStore.getState().globalTerminal.tabs;
        if (!currentTabs.some((t) => t.id === tab.id)) {
          await runCommandSafely(() => ipcClosePty(ptyId), {
            errorToast: false,
          });
          return;
        }

        tabPtyMapRef.current.set(tab.id, { ptyId, ready: true, mirror: false });
        setTabPtyMap(new Map(tabPtyMapRef.current));
        log("global-terminal", "pty created for tab", { tabId: tab.id });
      } catch (e) {
        logError("global-terminal", "failed to create pty for tab", e);
      } finally {
        pendingRef.current.delete(tab.id);
      }
    },
    [theme],
  );

  // Create PTYs for new tabs, clean up PTYs for removed tabs
  useEffect(() => {
    if (!theme) return;

    for (const tab of tabs) {
      if (tabPtyMapRef.current.has(tab.id) || pendingRef.current.has(tab.id)) continue;
      // Mirror tabs use an existing PTY — no need to spawn a new one
      if (tab.mirrorPtyId) {
        tabPtyMapRef.current.set(tab.id, { ptyId: tab.mirrorPtyId, ready: true, mirror: true });
        continue;
      }
      void createPtyForTab(tab);
    }

    // Clean up PTYs for removed tabs (don't close mirror PTYs — they belong to worktree)
    const tabIds = new Set(tabs.map((t) => t.id));
    for (const [tabId, state] of tabPtyMapRef.current) {
      if (!tabIds.has(tabId)) {
        tabPtyMapRef.current.delete(tabId);
        if (!state.mirror) {
          void runCommandSafely(() => ipcClosePty(state.ptyId), {
            errorToast: false,
          });
        }
      }
    }
    // Only update state if map actually changed
    if (
      tabPtyMapRef.current.size !== tabPtyMap.size ||
      [...tabPtyMapRef.current].some(([k, v]) => tabPtyMap.get(k)?.ptyId !== v.ptyId)
    ) {
      setTabPtyMap(new Map(tabPtyMapRef.current));
    }
  }, [tabs, theme, createPtyForTab]);

  const addTab = useCallback((opts?: { title?: string; cwd?: string }) => {
    return usePanelLayoutStore.getState().addGlobalTerminalTab(opts);
  }, []);

  const addMirrorTab = useCallback((title: string, ptyId: string) => {
    return usePanelLayoutStore.getState().addGlobalTerminalMirrorTab(title, ptyId);
  }, []);

  const removeMirrorTabs = useCallback(() => {
    const gt = usePanelLayoutStore.getState().globalTerminal;
    const { stopMirror } = useBroadcastStore.getState();
    for (const tab of gt.tabs) {
      if (tab.mirrorPtyId) {
        const ended = stopMirror(tab.mirrorPtyId);
        restoreBroadcastSessionSize(ended);
        usePanelLayoutStore.getState().removeGlobalTerminalTab(tab.id);
      }
    }
  }, []);

  const removeTab = useCallback((tabId: string) => {
    // If removing a mirror tab, stop the broadcast so the original pane can re-attach.
    const gt = usePanelLayoutStore.getState().globalTerminal;
    const tab = gt.tabs.find((t) => t.id === tabId);
    if (tab?.mirrorPtyId) {
      const { mirrors, stopMirror } = useBroadcastStore.getState();
      if (mirrors[tab.mirrorPtyId]) {
        const ended = stopMirror(tab.mirrorPtyId);
        restoreBroadcastSessionSize(ended);
      }
    }
    usePanelLayoutStore.getState().removeGlobalTerminalTab(tabId);
  }, []);

  const selectTab = useCallback((tabId: string) => {
    usePanelLayoutStore.getState().setActiveGlobalTerminalTab(tabId);
  }, []);

  const getTabPtyId = useCallback(
    (tabId: string) => tabPtyMap.get(tabId)?.ptyId ?? "",
    [tabPtyMap],
  );

  const isTabReady = useCallback(
    (tabId: string) => tabPtyMap.get(tabId)?.ready ?? false,
    [tabPtyMap],
  );

  return {
    tabs,
    activeTabId,
    addTab,
    addMirrorTab,
    removeMirrorTabs,
    removeTab,
    selectTab,
    getTabPtyId,
    isTabReady,
  };
}
