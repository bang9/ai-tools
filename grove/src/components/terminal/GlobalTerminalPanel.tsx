import { memo, useEffect, useLayoutEffect, useRef } from "react";
import { ChevronUp, ChevronDown } from "lucide-react";
import { useTerminalStore } from "../../store/terminal";
import { useBroadcastStore } from "../../store/broadcast";
import { usePanelLayoutStore, type GlobalTerminalTab } from "../../store/panel-layout";
import { requestTerminalLayoutSync } from "../../lib/terminal-layout-sync";
import { acquireTerminalRuntime } from "../../lib/terminal-runtime";
import { cn } from "../../lib/cn";
import { IconButton } from "../ui/button";
import GlobalTerminalTabBar from "./GlobalTerminalTabBar";

interface TerminalTabContentProps {
  tab: GlobalTerminalTab;
  ptyId: string;
  isActive: boolean;
  direction: "left" | "right" | "none";
}

const TerminalTabContent = memo(function TerminalTabContent({
  tab,
  ptyId,
  isActive,
  direction,
}: TerminalTabContentProps) {
  const theme = useTerminalStore((s) => s.theme);
  const mirrorSession = useBroadcastStore((s) =>
    tab.mirrorPtyId ? (s.mirrors[tab.mirrorPtyId] ?? null) : null,
  );
  const termRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<ReturnType<
    typeof acquireTerminalRuntime
  > | null>(null);
  const runtimePaneId = mirrorSession?.paneId ?? tab.paneId;

  useLayoutEffect(() => {
    const container = termRef.current;
    if (!container || !ptyId) return;

    const isMirror = Boolean(tab.mirrorPtyId);
    let runtime: ReturnType<typeof acquireTerminalRuntime> | null;
    if (isMirror) {
      runtime = mirrorSession
        ? acquireTerminalRuntime(mirrorSession.paneId, theme)
        : null;
    } else {
      runtime = acquireTerminalRuntime(tab.paneId, theme);
    }
    if (!runtime) return;

    runtimeRef.current = runtime;
    runtime.setPtyId(ptyId);
    runtime.attach(container);
    requestTerminalLayoutSync({ paneId: runtimePaneId, source: "attach" });

    return () => {
      runtime.detach(container);
      runtime.release();
      runtimeRef.current = null;
    };
  }, [
    mirrorSession?.paneId,
    ptyId,
    tab.mirrorPtyId,
    tab.paneId,
    runtimePaneId,
  ]);

  // Refit when becoming active
  useEffect(() => {
    if (!isActive) return;
    requestTerminalLayoutSync({ paneId: runtimePaneId, source: "globalTerminal" });
  }, [isActive, runtimePaneId]);

  // Inactive tabs stay mounted and full-size (translated offscreen for the
  // slide animation), so gate them against paneless layout-sync broadcasts to
  // skip the per-frame fit while hidden. The on-activate refit above (targeted
  // by paneId) still re-fits them when shown. Keyed on the resolved paneId so
  // mirror tabs gate on their source pane's runtime.
  // Inactive tabs are translated offscreen but keep full dimensions, so drive
  // WebGL suspension from the explicit isActive flag (a rect check would still
  // see them as visible). Suspend on hide frees the GPU context; reveal reloads.
  useEffect(() => {
    runtimeRef.current?.setLayoutSyncSuppressed(!isActive);
    runtimeRef.current?.setVisible(isActive);
  }, [isActive, runtimePaneId, mirrorSession?.paneId, ptyId, tab.mirrorPtyId, tab.paneId]);

  // Update theme
  useEffect(() => {
    runtimeRef.current?.setTheme(theme);
  }, [theme]);

  let translateX = "translateX(100%)";
  if (isActive) {
    translateX = "translateX(0)";
  } else if (direction === "left") {
    translateX = "translateX(-100%)";
  }

  return (
    <div
      className={cn("absolute inset-0 p-4 transition-transform duration-300 ease-out")}
      style={{ transform: translateX }}
    >
      <div ref={termRef} className={cn("h-full w-full")} />
    </div>
  );
});

interface Props {
  tabs: GlobalTerminalTab[];
  activeTabId: string;
  getTabPtyId: (tabId: string) => string;
  isTabReady: (tabId: string) => boolean;
  onAdd: () => void;
  onRemove: (tabId: string) => void;
  onSelect: (tabId: string) => void;
}

function GlobalTerminalPanel({
  tabs,
  activeTabId,
  getTabPtyId,
  isTabReady,
  onAdd,
  onRemove,
  onSelect,
}: Props) {
  const theme = useTerminalStore((s) => s.theme);
  const collapsed = usePanelLayoutStore((s) => s.globalTerminal.collapsed);
  const updateGlobalTerminal = usePanelLayoutStore(
    (s) => s.updateGlobalTerminal,
  );

  const toggle = () => {
    updateGlobalTerminal({ collapsed: !collapsed });
  };

  const activeIdx = tabs.findIndex((t) => t.id === activeTabId);

  return (
    <div className={cn("flex flex-col", { "h-full": !collapsed })}>
      <div
        className={cn(
          "flex items-center justify-between border-t border-border bg-sidebar px-2 h-7 shrink-0",
        )}
      >
        <div className={cn("flex items-center gap-1 min-w-0 flex-1")}>
          <GlobalTerminalTabBar
            tabs={tabs}
            activeTabId={activeTabId}
            onSelect={(tabId) => {
              onSelect(tabId);
              updateGlobalTerminal({ collapsed: false });
            }}
            onAdd={onAdd}
            onClose={onRemove}
          />
        </div>
        <IconButton onClick={toggle} title={collapsed ? "Expand" : "Collapse"}>
          {collapsed ? (
            <ChevronUp className={cn("size-3.5")} />
          ) : (
            <ChevronDown className={cn("size-3.5")} />
          )}
        </IconButton>
      </div>
      {!collapsed && (
        <div
          className={cn("flex-1 relative overflow-hidden")}
          style={{ backgroundColor: theme?.background ?? "#000" }}
        >
          {tabs.map((tab, idx) => {
            const ptyId = getTabPtyId(tab.id);
            if (!isTabReady(tab.id) || !ptyId) return null;
            const isActive = tab.id === activeTabId;
            let direction: "left" | "right" | "none" = "right";
            if (isActive) {
              direction = "none";
            } else if (idx < activeIdx) {
              direction = "left";
            }
            return (
              <TerminalTabContent
                key={tab.id}
                tab={tab}
                ptyId={ptyId}
                isActive={isActive}
                direction={direction}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

export default memo(GlobalTerminalPanel);
