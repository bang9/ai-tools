import { useEffect } from "react";
import { Command } from "lucide-react";
import { cn } from "./lib/cn";
import Sidebar from "./components/sidebar/Sidebar";
import AppTabBar from "./components/tab/AppTabBar";
import AppTabContent from "./components/tab/AppTabContent";
import RightPanel from "./components/right-panel/RightPanel";
import ResizablePanelGroup from "./components/ui/resizable-panel-group";
import { windowDragRegionProps } from "./lib/platform";
import { usePanelLayoutStore } from "./store/panel-layout";
import { useFullscreen } from "./hooks/useFullscreen";
import { usePtyResizeHold } from "./hooks/usePtyResizeHold";

const TITLE_BAR_HEIGHT = 38;

function TitleBar() {
  const isFullscreen = useFullscreen();

  return (
    <div
      className={cn("flex items-center shrink-0 bg-sidebar select-none border-b border-border")}
      style={{ height: TITLE_BAR_HEIGHT }}
      {...windowDragRegionProps}
    >
      {/* Traffic light spacer (macOS) / padding in fullscreen */}
      {!isFullscreen && <div className={cn("w-[86px] shrink-0")} {...windowDragRegionProps} />}

      {/* Logo */}
      <div
        className={cn("flex items-center gap-1", { "pl-4": isFullscreen })}
        {...windowDragRegionProps}
      >
        <div className={cn("flex h-5 w-5 items-center justify-center rounded bg-accent")}>
          <Command className={cn("h-3 w-3 text-white")} />
        </div>
        <span className={cn("text-xs font-semibold text-foreground")}>
          grove{import.meta.env.DEV && " (dev)"}
        </span>
      </div>
    </div>
  );
}

function Layout() {
  const main = usePanelLayoutStore((s) => s.main);
  const loaded = usePanelLayoutStore((s) => s.loaded);
  const init = usePanelLayoutStore((s) => s.init);
  const updateMain = usePanelLayoutStore((s) => s.updateMain);
  // The center pane hosts the terminal area, so this sash indirectly resizes
  // every visible terminal — hold all PTY resizes for the drag.
  const handleDragStateChange = usePtyResizeHold();

  useEffect(() => {
    void init();
  }, [init]);

  if (!loaded) return null;

  return (
    <div className={cn("flex flex-col h-full w-full bg-background")}>
      <TitleBar />
      <ResizablePanelGroup
        className={cn("flex-1 min-h-0")}
        ratios={main}
        onCommit={updateMain}
        onDragStateChange={handleDragStateChange}
      >
        <ResizablePanelGroup.Pane minSize={180}>
          <Sidebar />
        </ResizablePanelGroup.Pane>
        <ResizablePanelGroup.Pane>
          <div className={cn("flex flex-col h-full")}>
            <AppTabBar />
            <AppTabContent />
          </div>
        </ResizablePanelGroup.Pane>
        <ResizablePanelGroup.Pane minSize={200}>
          <RightPanel />
        </ResizablePanelGroup.Pane>
      </ResizablePanelGroup>
    </div>
  );
}

export default Layout;
