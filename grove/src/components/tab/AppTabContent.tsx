import { useCallback, useEffect, useRef, useState } from "react";
import { useTabStore, selectActiveTabIdForWorktree, selectTabsForWorktree } from "../../store/tab";
import { useTerminalStore } from "../../store/terminal";
import { usePanelLayoutStore } from "../../store/panel-layout";
import { useBroadcastStore } from "../../store/broadcast";
import { useGlobalTerminal } from "../../hooks/useGlobalTerminal";
import { useResolvedSidebarSelection } from "../../hooks/useResolvedSidebarSelection";
import {
  acquireTerminalRuntime,
  getRuntimeSize,
  captureRuntimeSnapshot,
} from "../../lib/terminal-runtime";
import { buildBroadcastSessionKey, restoreBroadcastSessionSize } from "../../lib/broadcast-session";
import { collectTerminalPanes } from "../../lib/terminal-session";
import { shouldStartPipBroadcast } from "../../lib/broadcast-policy";
import { cn } from "../../lib/cn";
import { DEFAULT_PIP_PRESENTATION, type PipPresentationState } from "../../lib/pip-floating";
import { requestTerminalLayoutSync } from "../../lib/terminal-layout-sync";
import { initBrowserWebviewBridge } from "../../lib/browser-webview";
import TerminalPanel from "../terminal/TerminalPanel";
import ChangesPanel from "./ChangesPanel";
import BrowserPanel from "./BrowserPanel";
import PipTerminal from "./PipTerminal";
import GlobalTerminalPanel from "../terminal/GlobalTerminalPanel";
import { ResizablePanelGroup } from "../ui/resizable-panel-group";

/** Find paneId for a given ptyId in the terminal sessions */
function findPaneIdForPty(ptyId: string): string | null {
  const sessions = useTerminalStore.getState().sessions;
  for (const node of Object.values(sessions)) {
    for (const pane of collectTerminalPanes(node)) {
      if (pane.ptyId === ptyId) return pane.paneId;
    }
  }
  return null;
}

function AppTabContent() {
  const { worktreePath } = useResolvedSidebarSelection();
  const setActiveWorktree = useTabStore((s) => s.setActiveWorktree);

  useEffect(() => {
    setActiveWorktree(worktreePath);
  }, [worktreePath, setActiveWorktree]);

  // Wire native browser nav events + orphan cleanup at app startup, not just
  // when the first browser tab mounts (idempotent).
  useEffect(() => {
    initBrowserWebviewBridge();
  }, []);

  const activeTabId = useTabStore((state) => selectActiveTabIdForWorktree(state, worktreePath));
  const tabs = useTabStore((state) => selectTabsForWorktree(state, worktreePath));
  const browserTabs = tabs.filter((tab) => tab.type === "browser");
  const isTerminal = activeTabId === "terminal";
  const isChanges = activeTabId === "changes";
  const activeTabIsBrowser = browserTabs.some((tab) => tab.id === activeTabId);

  const theme = useTerminalStore((s) => s.theme);
  const focusedPtyId = useTerminalStore((s) => s.focusedPtyId);
  const pips = useBroadcastStore((s) => s.pips);
  const pip = useBroadcastStore((s) => (worktreePath ? (s.pips[worktreePath] ?? null) : null));
  const isFocusedPtyMirroring = useBroadcastStore((s) =>
    focusedPtyId ? Boolean(s.mirrors[focusedPtyId]) : false,
  );
  const startPip = useBroadcastStore((s) => s.startPip);
  const stopPip = useBroadcastStore((s) => s.stopPip);

  const [pipPresentationByWorktree, setPipPresentationByWorktree] = useState<
    Record<string, PipPresentationState>
  >({});
  const prevIsTerminalRef = useRef(isTerminal);
  const prevWorktreePathRef = useRef(worktreePath);
  const pipBoundsRef = useRef<HTMLDivElement>(null);
  const pipContainerRef = useRef<HTMLDivElement>(null);
  const pipRuntimeMapRef = useRef(
    new Map<
      string,
      {
        ptyId: string;
        paneId: string;
        sessionKey: string;
        runtime: ReturnType<typeof acquireTerminalRuntime>;
      }
    >(),
  );
  const attachedPipSessionRef = useRef<{ worktreePath: string; sessionKey: string } | null>(null);

  const pipPresentation = worktreePath
    ? (pipPresentationByWorktree[worktreePath] ?? DEFAULT_PIP_PRESENTATION)
    : DEFAULT_PIP_PRESENTATION;

  // PiP broadcast policy
  useEffect(() => {
    const wasTerminal = prevIsTerminalRef.current;
    const worktreeChanged = prevWorktreePathRef.current !== worktreePath;
    prevIsTerminalRef.current = isTerminal;
    prevWorktreePathRef.current = worktreePath;

    if (isTerminal) {
      // Returning to Terminal tab — stop PiP broadcast if active
      if (worktreePath && pip) {
        const ended = stopPip(worktreePath);
        restoreBroadcastSessionSize(ended);
      }
    } else if (
      !worktreeChanged &&
      worktreePath &&
      shouldStartPipBroadcast({
        isTerminal,
        wasTerminal,
        focusedPtyId,
        hasActivePip: Boolean(pip),
        isFocusedPtyMirroring,
        activeTabIsBrowser,
      })
    ) {
      if (!focusedPtyId) {
        return;
      }
      const ptyId = focusedPtyId;
      const paneId = findPaneIdForPty(ptyId);
      if (paneId) {
        const { cols, rows } = getRuntimeSize(paneId);
        const snapshot = captureRuntimeSnapshot(paneId);
        startPip(worktreePath, ptyId, paneId, cols, rows, snapshot);
      }
    }
  }, [
    activeTabIsBrowser,
    isFocusedPtyMirroring,
    isTerminal,
    focusedPtyId,
    pip,
    worktreePath,
    startPip,
    stopPip,
  ]);

  const hasPipBroadcast = !isTerminal && !!worktreePath && !!pip;

  useEffect(() => {
    const runtimeMap = pipRuntimeMapRef.current;
    const activeWorktreePaths = new Set(Object.keys(pips));

    for (const [worktreePath, session] of Object.entries(pips)) {
      const sessionKey = buildBroadcastSessionKey(worktreePath, session);
      const current = runtimeMap.get(worktreePath);
      if (current?.sessionKey === sessionKey) {
        continue;
      }

      current?.runtime.detach(pipContainerRef.current);
      current?.runtime.release();

      runtimeMap.set(worktreePath, {
        ptyId: session.ptyId,
        paneId: session.paneId,
        sessionKey,
        runtime: acquireTerminalRuntime(session.paneId, theme),
      });
    }

    for (const [worktreePath, entry] of runtimeMap.entries()) {
      if (activeWorktreePaths.has(worktreePath)) {
        continue;
      }

      entry.runtime.detach(pipContainerRef.current);
      entry.runtime.release();
      runtimeMap.delete(worktreePath);
      if (attachedPipSessionRef.current?.worktreePath === worktreePath) {
        attachedPipSessionRef.current = null;
      }
    }
  }, [pips, theme]);

  useEffect(() => {
    for (const { runtime } of pipRuntimeMapRef.current.values()) {
      runtime.setTheme(theme);
    }
  }, [theme]);

  useEffect(() => {
    const runtimeMap = pipRuntimeMapRef.current;
    const activeSessionKey =
      pip && worktreePath ? buildBroadcastSessionKey(worktreePath, pip) : null;
    const attachedSession = attachedPipSessionRef.current;
    if (
      attachedSession &&
      (!worktreePath ||
        attachedSession.worktreePath !== worktreePath ||
        !hasPipBroadcast ||
        attachedSession.sessionKey !== activeSessionKey)
    ) {
      runtimeMap.get(attachedSession.worktreePath)?.runtime.detach(pipContainerRef.current);
      attachedPipSessionRef.current = null;
    }

    if (!hasPipBroadcast || !pip || !worktreePath) {
      return;
    }

    const container = pipContainerRef.current;
    const entry = runtimeMap.get(worktreePath);
    if (!container || !entry) {
      return;
    }

    entry.runtime.attach(container);
    attachedPipSessionRef.current = {
      worktreePath,
      sessionKey: activeSessionKey ?? entry.sessionKey,
    };
    requestTerminalLayoutSync({ paneId: entry.paneId, source: "attach" });
  }, [hasPipBroadcast, pip?.paneId, pip?.ptyId, worktreePath]);

  useEffect(
    () => () => {
      for (const { runtime } of pipRuntimeMapRef.current.values()) {
        runtime.detach(pipContainerRef.current);
        runtime.release();
      }
      pipRuntimeMapRef.current.clear();
      attachedPipSessionRef.current = null;
    },
    [],
  );

  const {
    tabs: globalTabs,
    activeTabId: globalActiveTabId,
    addTab: addGlobalTab,
    removeTab: removeGlobalTab,
    selectTab: selectGlobalTab,
    getTabPtyId: getGlobalTabPtyId,
    isTabReady: isGlobalTabReady,
  } = useGlobalTerminal();

  const collapsed = usePanelLayoutStore((s) => s.globalTerminal.collapsed);
  const ratio = usePanelLayoutStore((s) => s.globalTerminal.ratio);
  const updateGlobalTerminal = usePanelLayoutStore((s) => s.updateGlobalTerminal);

  const handleRatioCommit = useCallback(
    (ratios: number[]) => {
      if (ratios.length === 2) {
        updateGlobalTerminal({ ratio: ratios[1] });
      }
    },
    [updateGlobalTerminal],
  );

  const hasGlobalPanel = globalTabs.length > 0;

  useEffect(() => {
    requestTerminalLayoutSync({ source: "tabSwitch" });
  }, [activeTabId, worktreePath]);

  useEffect(() => {
    requestTerminalLayoutSync({ source: "broadcast" });
  }, [hasPipBroadcast, pip?.paneId, pip?.ptyId, worktreePath]);

  useEffect(() => {
    requestTerminalLayoutSync({ source: "globalTerminal" });
  }, [collapsed, hasGlobalPanel, ratio]);

  const globalPanel = hasGlobalPanel ? (
    <GlobalTerminalPanel
      tabs={globalTabs}
      activeTabId={globalActiveTabId}
      getTabPtyId={getGlobalTabPtyId}
      isTabReady={isGlobalTabReady}
      onAdd={addGlobalTab}
      onRemove={removeGlobalTab}
      onSelect={selectGlobalTab}
    />
  ) : null;

  const setActiveTab = useTabStore((s) => s.setActiveTab);

  const updatePipPresentation = useCallback(
    (next: PipPresentationState) => {
      if (!worktreePath) {
        return;
      }
      setPipPresentationByWorktree((state) => ({
        ...state,
        [worktreePath]: next,
      }));
    },
    [worktreePath],
  );

  const activePipKey = pip && worktreePath ? buildBroadcastSessionKey(worktreePath, pip) : null;

  const pipElement = hasPipBroadcast && !activeTabIsBrowser && (
    <PipTerminal
      key={activePipKey ?? "pip"}
      boundaryRef={pipBoundsRef}
      containerRef={pipContainerRef}
      presentation={pipPresentation}
      onPresentationChange={updatePipPresentation}
      onOpenTerminal={() => setActiveTab("terminal")}
    />
  );

  const tabContent = (
    <>
      {/* Terminal always mounted, hidden when not active tab */}
      <div
        className={cn("absolute inset-0 flex flex-col")}
        style={{ display: isTerminal ? "flex" : "none" }}
      >
        <TerminalPanel />
      </div>

      {isChanges && (
        <div className={cn("absolute inset-0")}>
          <ChangesPanel />
        </div>
      )}

      {/* Browser tabs stay mounted so pages survive tab switches */}
      {browserTabs.map((tab) => (
        <div
          key={tab.id}
          className={cn("absolute inset-0")}
          style={{ display: tab.id === activeTabId ? "block" : "none" }}
        >
          <BrowserPanel tabId={tab.id} isActive={tab.id === activeTabId} />
        </div>
      ))}

      {pipElement}
    </>
  );

  if (!hasGlobalPanel || collapsed) {
    return (
      <div className={cn("flex flex-col flex-1 min-h-0")}>
        <div ref={pipBoundsRef} className={cn("flex-1 relative overflow-hidden")}>
          {tabContent}
        </div>
        {globalPanel}
      </div>
    );
  }

  return (
    <ResizablePanelGroup
      className={cn("flex-1 min-h-0")}
      vertical
      ratios={[1 - ratio, ratio]}
      onLayout={() => {
        requestTerminalLayoutSync({ source: "panelResize" });
      }}
      onCommit={handleRatioCommit}
    >
      <ResizablePanelGroup.Pane>
        <div ref={pipBoundsRef} className={cn("relative h-full overflow-hidden")}>
          {tabContent}
        </div>
      </ResizablePanelGroup.Pane>
      <ResizablePanelGroup.Pane>{globalPanel}</ResizablePanelGroup.Pane>
    </ResizablePanelGroup>
  );
}

export default AppTabContent;
