import { memo } from "react";
import { Plus, X } from "lucide-react";
import { cn } from "../../lib/cn";
import { IconButton } from "../ui/button";
import { useTerminalStore, type AiSession } from "../../store/terminal";
import { collectTerminalPanes } from "../../lib/terminal-session";
import { addTerminalTab, closeTerminalTab } from "../../lib/terminal-tab-commands";
import type { TerminalTab, WorktreeTerminalSession } from "../../types";

export function tabNeedsAttention(
  tab: TerminalTab,
  bellPtyIds: ReadonlySet<string>,
  aiSessions: Record<string, AiSession>,
): boolean {
  return collectTerminalPanes(tab.node).some(
    ({ ptyId }) => !!ptyId && (bellPtyIds.has(ptyId) || aiSessions[ptyId]?.status === "attention"),
  );
}

interface Props {
  worktreePath: string;
  session: WorktreeTerminalSession;
}

function TerminalTabBar({ worktreePath, session }: Props) {
  const setActiveTab = useTerminalStore((s) => s.setActiveTab);
  const bellPtyIds = useTerminalStore((s) => s.bellPtyIds);
  const aiSessions = useTerminalStore((s) => s.aiSessions);

  return (
    <div
      className={cn("flex h-7 shrink-0 items-center gap-1 border-b border-border bg-sidebar px-2")}
    >
      {session.tabs.map((tab, index) => {
        const isActive = tab.id === session.activeTabId;
        const needsAttention = !isActive && tabNeedsAttention(tab, bellPtyIds, aiSessions);
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(worktreePath, tab.id)}
            className={cn(
              "group flex h-5 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 text-xs",
              {
                "bg-accent text-foreground": isActive,
                "text-muted-foreground hover:bg-accent/50 hover:text-foreground": !isActive,
              },
            )}
          >
            <span>{index + 1}</span>
            {needsAttention && <span className={cn("size-1.5 rounded-full bg-red-500")} />}
            {session.tabs.length > 1 && (
              <span
                role="button"
                tabIndex={-1}
                onClick={(event) => {
                  event.stopPropagation();
                  closeTerminalTab(worktreePath, tab.id).catch(() => {});
                }}
                title="Close Tab"
                className={cn(
                  "shrink-0 rounded-sm p-0.5 opacity-0 hover:bg-muted group-hover:opacity-100",
                  {
                    "opacity-100": isActive,
                  },
                )}
              >
                <X className={cn("size-2.5")} />
              </span>
            )}
          </button>
        );
      })}
      <IconButton
        onClick={() => {
          addTerminalTab(worktreePath).catch(() => {});
        }}
        title="New Terminal Tab"
        aria-label="New Terminal Tab"
        className={cn("h-5 w-5 shrink-0")}
      >
        <Plus className={cn("size-3")} />
      </IconButton>
    </div>
  );
}

export default memo(TerminalTabBar);
