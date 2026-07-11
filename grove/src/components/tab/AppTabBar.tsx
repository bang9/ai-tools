import { useCallback, useMemo, useState } from "react";
import { GitPullRequest, Globe, Loader2, Plus, Settings, X } from "lucide-react";
import { cn } from "../../lib/cn";
import { IconButton } from "../ui/button";
import { useTabStore, selectActiveTabIdForWorktree, selectTabsForWorktree } from "../../store/tab";
import { useResolvedSidebarSelection } from "../../hooks/useResolvedSidebarSelection";
import { usePreferencesUiStore } from "../../store/preferences-ui";
import { useMissionStore } from "../../store/mission";
import { useProjectStore } from "../../store/project";
import type { AppTabType } from "../../types";
import { useWorktreePrUrl } from "../sidebar/worktree-pr";
import { runCommand } from "../../lib/command";
import { createWorktreePr, openExternal } from "../../lib/platform";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import PreferencesModal from "../preferences/PreferencesModal";

const ADD_TAB_OPTIONS: {
  type: Exclude<AppTabType, "terminal" | "changes">;
  label: string;
  icon: typeof Globe;
}[] = [{ type: "browser", label: "Browser", icon: Globe }];

function SelectedWorktreePrAction({ worktreePath }: { worktreePath: string | null }) {
  const projects = useProjectStore((state) => state.projects);
  const missions = useMissionStore((state) => state.missions);
  const missionSelectedItem = useMissionStore((state) => state.selectedItem);
  const target = useMemo(() => {
    if (!worktreePath) {
      return null;
    }

    if (missionSelectedItem?.projectId) {
      const mission = missions.find((item) => item.id === missionSelectedItem.missionId);
      const missionProject = mission?.projects.find(
        (item) => item.projectId === missionSelectedItem.projectId,
      );
      const project = projects.find((item) => item.id === missionSelectedItem.projectId);

      if (missionProject && project && missionProject.path === worktreePath) {
        return {
          kind: "worktree" as const,
          projectOrg: project.org,
          projectRepo: project.repo,
          worktreeBranch: missionProject.branch,
          worktreePath: missionProject.path,
        };
      }
    }

    for (const project of projects) {
      if (project.sourcePath === worktreePath) {
        return {
          kind: "source" as const,
          worktreePath,
        };
      }

      const worktree = project.worktrees.find((item) => item.path === worktreePath);
      if (worktree) {
        return {
          kind: "worktree" as const,
          projectOrg: project.org,
          projectRepo: project.repo,
          worktreeBranch: worktree.branch,
          worktreePath: worktree.path,
        };
      }
    }

    return null;
  }, [missionSelectedItem, missions, projects, worktreePath]);
  const { isLoading, hasFetchedBefore, pullRequest, refresh } = useWorktreePrUrl(
    target?.kind === "worktree"
      ? target
      : {
          projectOrg: "",
          projectRepo: "",
          worktreeBranch: "",
          worktreePath: "",
        },
  );

  const isSource = target?.kind === "source";
  const canCreate = target?.kind === "worktree" && !isLoading && !pullRequest;
  const disabled = isLoading || isSource || !target;
  const disabledOpacityClass = isSource || !target ? "disabled:opacity-30" : "disabled:opacity-100";
  let label = "Create PR";
  let title = "Create pull request";
  let colorClass = "border-transparent bg-[#1f883d] text-white hover:bg-[#1a7f37]";

  if (isLoading && !hasFetchedBefore) {
    label = "Checking PR";
    title = "Checking pull request status";
    colorClass = "border-transparent bg-[#57606a] text-white hover:bg-[#4f5864]";
  } else if (isSource || !target) {
    title = "Pull requests are unavailable on the source branch";
    colorClass = "border-transparent bg-[#768390] text-white shadow-none";
  } else if (pullRequest?.status === "merged") {
    label = "Merged PR";
    title = "Open merged pull request";
    colorClass = "border-transparent bg-[#8250df] text-white hover:bg-[#6f42c1]";
  } else if (pullRequest) {
    label = "Open PR";
    title = "Open pull request";
  } else if (canCreate) {
    label = "Create PR";
    title = "Create pull request";
  }

  const handleClick = () => {
    if (!target || isLoading || isSource) {
      return;
    }

    if (pullRequest?.url) {
      void runCommand(() => openExternal(pullRequest.url), {
        errorToast: "Failed to open pull request",
      });
      return;
    }

    refresh();
    void runCommand(() => createWorktreePr(target.worktreePath), {
      errorToast: "Failed to create pull request",
    });
  };

  return (
    <div className={cn("flex min-w-0 items-center gap-2")}>
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled}
        title={title}
        aria-label={title}
        className={cn(
          "inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-semibold tracking-[0.01em] transition-all shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
          "disabled:cursor-not-allowed",
          disabledOpacityClass,
          colorClass,
        )}
      >
        {isLoading ? (
          <Loader2 className={cn("h-3 w-3 animate-spin")} />
        ) : (
          <GitPullRequest className={cn("h-3 w-3")} />
        )}
        <span className={cn("leading-none")}>{label}</span>
      </button>
    </div>
  );
}

function AppTabBar() {
  const { terminalPath, worktreePath } = useResolvedSidebarSelection();
  // Same scope as AppTabContent: mission roots (terminal path, no worktree)
  // get working tab sessions too.
  const tabScopePath = worktreePath ?? terminalPath;
  const tabs = useTabStore((state) => selectTabsForWorktree(state, tabScopePath));
  const activeTabId = useTabStore((state) => selectActiveTabIdForWorktree(state, tabScopePath));
  const setActiveTab = useTabStore((s) => s.setActiveTab);
  const closeTab = useTabStore((s) => s.closeTab);
  const addTab = useTabStore((s) => s.addTab);
  const [menuOpen, setMenuOpen] = useState(false);
  const preferencesOpen = usePreferencesUiStore((state) => state.open);
  const preferencesTab = usePreferencesUiStore((state) => state.activeTab);
  const openPreferences = usePreferencesUiStore((state) => state.openPreferences);
  const closePreferences = usePreferencesUiStore((state) => state.closePreferences);
  const setPreferencesTab = usePreferencesUiStore((state) => state.setActiveTab);

  const handleAddTab = useCallback(
    (type: Exclude<AppTabType, "terminal">, label: string) => {
      addTab(type, label);
      setMenuOpen(false);
    },
    [addTab],
  );

  return (
    <>
      <div
        className={cn(
          "flex items-center gap-1.5 px-2 h-9 shrink-0 min-w-0 border-b border-border bg-sidebar",
        )}
      >
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "group flex items-center gap-1.5 h-6 px-2 rounded-md shrink-0 text-xs font-medium",
                "backdrop-blur-sm border border-white/10 shadow-sm transition-all duration-200 ease-out",
                {
                  "bg-white/15 text-foreground shadow-[0_2px_8px_rgba(0,0,0,0.3),inset_0_1px_0_0_rgba(255,255,255,0.15)] -translate-y-0.5 scale-105":
                    isActive,
                  "bg-white/30 text-muted-foreground border-white/45 shadow-[0_1px_6px_rgba(0,0,0,0.3)] translate-y-0 scale-100 hover:-translate-y-0.5 hover:scale-105 hover:bg-white/35 hover:text-foreground hover:shadow-[0_2px_8px_rgba(0,0,0,0.3),inset_0_1px_0_0_rgba(255,255,255,0.15)]":
                    !isActive,
                },
              )}
            >
              <span className={cn("max-w-40 truncate")}>{tab.title}</span>
              {tab.closable && (
                <span
                  role="button"
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
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

        {/* Add tab dropdown — hidden without a tab scope (tabs are per-scope) */}
        {tabScopePath && (
          <Popover open={menuOpen} onOpenChange={setMenuOpen}>
            <PopoverTrigger asChild>
              <IconButton title="Add tab" aria-label="Add tab" className={cn("shrink-0")}>
                <Plus className={cn("size-3")} />
              </IconButton>
            </PopoverTrigger>
            <PopoverContent className={cn("w-auto min-w-[140px] p-1")}>
              {ADD_TAB_OPTIONS.map(({ type, label, icon: Icon }) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => handleAddTab(type, label)}
                  className={cn(
                    "flex items-center gap-2 w-full rounded-sm px-2 py-1.5 text-xs",
                    "text-foreground hover:bg-accent hover:text-accent-foreground transition-colors",
                  )}
                >
                  <Icon className={cn("h-3.5 w-3.5")} />
                  <span>{label}</span>
                </button>
              ))}
            </PopoverContent>
          </Popover>
        )}

        {/* Workspace actions */}
        <div className={cn("ml-auto flex items-center gap-1.5 pl-2")}>
          <SelectedWorktreePrAction worktreePath={worktreePath} />
        </div>

        <div className={cn("hidden h-4 w-px bg-border/70 md:block")} />

        {/* Global actions */}
        <div className={cn("flex items-center gap-1.5")}>
          <IconButton
            onClick={() => openPreferences("general")}
            title="Preferences"
            aria-label="Preferences"
          >
            <Settings className={cn("size-3")} />
          </IconButton>
        </div>
      </div>
      <PreferencesModal
        open={preferencesOpen}
        onClose={closePreferences}
        activeTab={preferencesTab}
        onTabChange={setPreferencesTab}
      />
    </>
  );
}

export default AppTabBar;
