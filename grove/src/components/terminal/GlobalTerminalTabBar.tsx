import { memo } from "react";
import { Plus, X } from "lucide-react";
import { cn } from "../../lib/cn";
import { IconButton } from "../ui/button";
import type { GlobalTerminalTab } from "../../store/panel-layout";

function TerminalIcon() {
  return (
    <svg
      className={cn("text-current")}
      width="16"
      height="14"
      viewBox="0 0 18 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="0.75" y="0.75" width="16.5" height="12.5" rx="2" />
      <polyline points="5,5 7.5,7 5,9" />
      <line x1="9.5" y1="9" x2="13" y2="9" />
    </svg>
  );
}

interface Props {
  tabs: GlobalTerminalTab[];
  activeTabId: string;
  onSelect: (tabId: string) => void;
  onAdd: () => void;
  onClose: (tabId: string) => void;
}

function GlobalTerminalTabBar({ tabs, activeTabId, onSelect, onAdd, onClose }: Props) {
  return (
    <div className={cn("flex items-center gap-1.5 min-w-0 overflow-x-auto")}>
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        const isMirror = !!tab.mirrorPtyId;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onSelect(tab.id)}
            className={cn(
              "flex items-center gap-1.5 h-6 px-1.5 rounded-md shrink-0 group backdrop-blur-sm border border-white/10 shadow-sm transition-all duration-200 ease-out",
              {
                "w-16 justify-between": !isMirror,
                "bg-white/15 text-foreground shadow-[0_2px_8px_rgba(0,0,0,0.3),inset_0_1px_0_0_rgba(255,255,255,0.15)] -translate-y-0.5 scale-105":
                  isActive,
                "bg-white/30 text-muted-foreground border-white/45 shadow-[0_1px_6px_rgba(0,0,0,0.3)] translate-y-0 scale-100 hover:-translate-y-0.5 hover:scale-105 hover:bg-white/35 hover:text-foreground hover:shadow-[0_2px_8px_rgba(0,0,0,0.3),inset_0_1px_0_0_rgba(255,255,255,0.15)]":
                  !isActive,
              },
            )}
          >
            <span className={cn("relative inline-flex shrink-0")}>
              <TerminalIcon />
              {isMirror && (
                <span
                  className={cn(
                    "absolute top-[1px] left-[1px] -translate-x-1/2 -translate-y-1/2 flex items-center justify-center",
                  )}
                >
                  <span
                    className={cn("absolute size-[9px] rounded-full bg-red-500/40 animate-ping")}
                  />
                  <span className={cn("size-[5px] rounded-full bg-red-500")} />
                </span>
              )}
            </span>
            {isMirror && <span className={cn("text-[10px] whitespace-nowrap")}>{tab.title}</span>}
            {tabs.length > 1 && (
              <span
                role="button"
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
                className={cn(
                  "shrink-0 rounded-sm p-0.5 opacity-0 group-hover:opacity-100 hover:bg-muted",
                  { "opacity-100": isActive },
                )}
              >
                <X className={cn("size-2.5")} />
              </span>
            )}
          </button>
        );
      })}
      <IconButton
        onClick={onAdd}
        title="New Terminal Tab"
        aria-label="New Terminal Tab"
        className={cn("shrink-0")}
      >
        <Plus className={cn("size-3")} />
      </IconButton>
    </div>
  );
}

export default memo(GlobalTerminalTabBar);
