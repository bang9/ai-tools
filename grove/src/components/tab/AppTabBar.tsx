import { useCallback, useMemo, useState, type ReactNode } from "react";
import { DndContext, closestCenter, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import {
  FileDiff,
  GitPullRequest,
  Globe,
  Loader2,
  Plus,
  Settings,
  TerminalSquare,
  X,
} from "lucide-react";
import { cn } from "../../lib/cn";
import { IconButton } from "../ui/button";
import { SortableItem, usePointerDragSensors } from "../ui/sortable";
import { useInlineRename } from "../../hooks/useInlineRename";
import {
  useTabStore,
  selectActiveTabIdForWorktree,
  selectTabsForWorktree,
  CHANGES_TAB_ID,
  DEFAULT_TERMINAL_TAB_TITLE,
  TERMINAL_CONTENT_TAB_ID,
} from "../../store/tab";
import { useResolvedSidebarSelection } from "../../hooks/useResolvedSidebarSelection";
import { useSelectionCapabilities } from "../../hooks/useSelectionCapabilities";
import type { SelectionCapabilities } from "../../lib/selection-capabilities";
import { usePreferencesUiStore } from "../../store/preferences-ui";
import { useMissionStore } from "../../store/mission";
import { useProjectStore } from "../../store/project";
import { useTerminalStore, type AiSession } from "../../store/terminal";
import type { AppTabType, TerminalTab } from "../../types";
import { useWorktreePrUrl } from "../sidebar/worktree-pr";
import { runCommand } from "../../lib/command";
import { createWorktreePr, openExternal } from "../../lib/platform";
import { collectTerminalPanes } from "../../lib/terminal-session";
import { TERMINAL_PANE_LABEL_MAX_LENGTH } from "../../lib/split-tree";
import { addTerminalTab, closeTerminalTab } from "../../lib/terminal-tab-commands";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import PreferencesModal from "../preferences/PreferencesModal";

const ADD_TAB_OPTIONS: {
  type: Exclude<AppTabType, "file">;
  label: string;
  icon: typeof Globe;
  capability: keyof SelectionCapabilities;
}[] = [
  { type: "browser", label: "Browser", icon: Globe, capability: "browser" },
  { type: "terminal", label: "Terminal", icon: TerminalSquare, capability: "terminal" },
  { type: "changes", label: "Changes", icon: FileDiff, capability: "changes" },
];

const APP_TAB_CHIP_CLASS = cn(
  "group flex items-center h-6 max-w-36 px-2 rounded-md shrink-0 text-xs font-medium cursor-pointer",
  "backdrop-blur-sm border border-white/10 shadow-sm transition-all duration-200 ease-out",
);

function appTabChipStateClass(isActive: boolean) {
  return {
    "bg-white/15 text-foreground shadow-[0_2px_8px_rgba(0,0,0,0.3),inset_0_1px_0_0_rgba(255,255,255,0.15)] -translate-y-0.5 scale-105":
      isActive,
    "bg-white/30 text-muted-foreground border-white/45 shadow-[0_1px_6px_rgba(0,0,0,0.3)] translate-y-0 scale-100 hover:-translate-y-0.5 hover:scale-105 hover:bg-white/35 hover:text-foreground hover:shadow-[0_2px_8px_rgba(0,0,0,0.3),inset_0_1px_0_0_rgba(255,255,255,0.15)]":
      !isActive,
  };
}

function terminalTabNeedsAttention(
  tab: TerminalTab,
  bellPtyIds: ReadonlySet<string>,
  aiSessions: Record<string, AiSession>,
): boolean {
  return collectTerminalPanes(tab.node).some(
    ({ ptyId }) => !!ptyId && (bellPtyIds.has(ptyId) || aiSessions[ptyId]?.status === "attention"),
  );
}

/** A tab-chip favicon (browser tabs), falling back to a globe when absent/broken. */
function TabFavicon({ src }: { src?: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return <Globe className={cn("size-3 shrink-0 text-muted-foreground")} />;
  }
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      className={cn("size-3 shrink-0 rounded-[2px] object-contain")}
      onError={() => setFailed(true)}
    />
  );
}

/**
 * Shared chip: fixed max width with ellipsis; the close affordance takes no
 * space until the chip is hovered, then animates its width in. With onRename,
 * double-click swaps the title for an inline input (Enter/blur commit, Esc
 * cancels; an empty commit resets to the default name).
 */
function TabChip({
  title,
  isActive,
  needsAttention,
  leading,
  onSelect,
  onClose,
  closeTitle,
  onRename,
}: {
  title: string;
  isActive: boolean;
  needsAttention?: boolean;
  leading?: ReactNode;
  onSelect: () => void;
  onClose?: () => void;
  closeTitle?: string;
  onRename?: (title: string) => void;
}) {
  const rename = useInlineRename({
    maxLength: TERMINAL_PANE_LABEL_MAX_LENGTH,
    onCommit: (value) => onRename?.(value),
  });

  if (rename.editing && onRename) {
    return (
      <div className={cn(APP_TAB_CHIP_CLASS, appTabChipStateClass(isActive), "cursor-text")}>
        <input
          {...rename.inputProps}
          // Keep clicks in the input from activating the tab or arming a drag.
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          aria-label="Rename tab"
          className={cn("w-20 min-w-0 bg-transparent text-xs font-medium outline-none")}
        />
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onSelect}
      onDoubleClick={onRename ? () => rename.begin(title) : undefined}
      title={title}
      className={cn(APP_TAB_CHIP_CLASS, appTabChipStateClass(isActive))}
    >
      {leading && <span className={cn("mr-1 flex shrink-0 items-center")}>{leading}</span>}
      <span className={cn("min-w-0 truncate")}>{title}</span>
      {needsAttention && (
        <span className={cn("ml-1.5 size-1.5 shrink-0 rounded-full bg-red-500")} />
      )}
      {onClose && (
        <span
          role="button"
          tabIndex={-1}
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
          title={closeTitle}
          className={cn(
            "flex h-4 w-0 shrink-0 items-center justify-center overflow-hidden rounded-sm",
            "ml-0 opacity-0 transition-all duration-150 ease-out",
            "group-hover:ml-1 group-hover:w-4 group-hover:opacity-100 hover:bg-muted",
          )}
        >
          <X className={cn("size-2.5")} />
        </span>
      )}
    </button>
  );
}

/** A terminal tab entry: position from the tab store, content from the terminal store. */
function TerminalTabChip({
  terminalPath,
  tabEntryId,
  entryTitle,
  terminalIndex,
  isTerminalContentActive,
  onActivateTerminal,
}: {
  terminalPath: string | null;
  tabEntryId: string;
  entryTitle: string;
  terminalIndex: number;
  isTerminalContentActive: boolean;
  onActivateTerminal: () => void;
}) {
  const setActiveTerminalTab = useTerminalStore((s) => s.setActiveTab);
  const updateTabTitle = useTabStore((s) => s.updateTabTitle);
  const isActiveTerminalTab = useTerminalStore((s) =>
    terminalPath ? s.sessions[terminalPath]?.activeTabId === tabEntryId : false,
  );
  const needsAttention = useTerminalStore((s) => {
    if (!terminalPath) return false;
    const tab = s.sessions[terminalPath]?.tabs.find((entry) => entry.id === tabEntryId);
    return !!tab && terminalTabNeedsAttention(tab, s.bellPtyIds, s.aiSessions);
  });
  const isActive = isTerminalContentActive && isActiveTerminalTab;
  // The sync default title and "" both mean "no custom name" — show the
  // position-derived name until the user renames the tab.
  const customTitle =
    entryTitle && entryTitle !== DEFAULT_TERMINAL_TAB_TITLE ? entryTitle : undefined;
  const defaultTitle =
    terminalIndex === 0 ? DEFAULT_TERMINAL_TAB_TITLE : `Terminal ${terminalIndex + 1}`;

  return (
    <TabChip
      title={customTitle ?? defaultTitle}
      isActive={isActive}
      needsAttention={!isActive && needsAttention}
      onSelect={() => {
        if (terminalPath) {
          setActiveTerminalTab(terminalPath, tabEntryId);
        }
        onActivateTerminal();
      }}
      onClose={() => {
        if (terminalPath) {
          closeTerminalTab(terminalPath, tabEntryId).catch(() => {});
        }
      }}
      closeTitle="Close terminal tab"
      onRename={(next) => updateTabTitle(tabEntryId, next || DEFAULT_TERMINAL_TAB_TITLE)}
    />
  );
}

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
  const moveTab = useTabStore((s) => s.moveTab);
  const capabilities = useSelectionCapabilities();
  // Changes is a singleton per worktree — once open it leaves the + menu.
  const hasChangesTab = tabs.some((tab) => tab.id === CHANGES_TAB_ID);
  const addTabOptions = ADD_TAB_OPTIONS.filter(
    ({ type, capability }) => capabilities[capability] && !(type === "changes" && hasChangesTab),
  );
  const [menuOpen, setMenuOpen] = useState(false);

  const tabIds = useMemo(() => tabs.map((tab) => tab.id), [tabs]);
  // Terminal chips are numbered by their position among terminal entries.
  const terminalOrdinals = useMemo(() => {
    const ordinals = new Map<string, number>();
    for (const tab of tabs) {
      if (tab.type === "terminal") ordinals.set(tab.id, ordinals.size);
    }
    return ordinals;
  }, [tabs]);

  const dragSensors = usePointerDragSensors();
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const targetIndex = tabs.findIndex((tab) => tab.id === over.id);
      if (targetIndex >= 0) {
        moveTab(active.id as string, targetIndex);
      }
    },
    [moveTab, tabs],
  );
  const preferencesOpen = usePreferencesUiStore((state) => state.open);
  const preferencesTab = usePreferencesUiStore((state) => state.activeTab);
  const openPreferences = usePreferencesUiStore((state) => state.openPreferences);
  const closePreferences = usePreferencesUiStore((state) => state.closePreferences);
  const setPreferencesTab = usePreferencesUiStore((state) => state.setActiveTab);

  const handleAddTab = useCallback(
    (type: Exclude<AppTabType, "file">, label: string) => {
      if (type === "terminal") {
        if (terminalPath) {
          // Switch only after the tab exists — switching immediately would
          // flash the previously active terminal while the pty spawns.
          addTerminalTab(terminalPath)
            .then(() => setActiveTab(TERMINAL_CONTENT_TAB_ID))
            .catch(() => {});
        }
      } else {
        addTab(type, label);
      }
      setMenuOpen(false);
    },
    [addTab, setActiveTab, terminalPath],
  );

  return (
    <>
      <div
        className={cn(
          "flex items-center gap-1.5 px-2 h-9 shrink-0 min-w-0 border-b border-border bg-sidebar",
        )}
      >
        {/* Tab strip: takes the full remaining width and scrolls (scrollbar
            hidden); side padding keeps the hover scale/lift from clipping. */}
        <div
          className={cn(
            "flex h-full min-w-0 flex-1 items-center gap-1.5 overflow-x-auto px-1",
            "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          )}
        >
          <DndContext
            sensors={dragSensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToHorizontalAxis]}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={tabIds} strategy={horizontalListSortingStrategy}>
              {tabs.map((tab) => (
                // translateOnly: the strategy's scale component would stretch
                // the dragged chip to each neighbor's width as it passes over.
                <SortableItem key={tab.id} id={tab.id} translateOnly className={cn("shrink-0")}>
                  {tab.type === "terminal" ? (
                    <TerminalTabChip
                      terminalPath={terminalPath}
                      tabEntryId={tab.id}
                      entryTitle={tab.title}
                      terminalIndex={terminalOrdinals.get(tab.id) ?? 0}
                      isTerminalContentActive={activeTabId === TERMINAL_CONTENT_TAB_ID}
                      onActivateTerminal={() => setActiveTab(TERMINAL_CONTENT_TAB_ID)}
                    />
                  ) : (
                    <TabChip
                      title={tab.title}
                      isActive={tab.id === activeTabId}
                      leading={
                        tab.type === "browser" ? <TabFavicon src={tab.faviconUrl} /> : undefined
                      }
                      onSelect={() => setActiveTab(tab.id)}
                      onClose={() => closeTab(tab.id)}
                      closeTitle="Close tab"
                    />
                  )}
                </SortableItem>
              ))}
            </SortableContext>
          </DndContext>

          {/* Add tab dropdown — needs a directory selection (tabs are per-scope) */}
          {capabilities.hasDirectory && (
            <Popover open={menuOpen} onOpenChange={setMenuOpen}>
              <PopoverTrigger asChild>
                <IconButton title="Add tab" aria-label="Add tab" className={cn("shrink-0")}>
                  <Plus className={cn("size-3")} />
                </IconButton>
              </PopoverTrigger>
              <PopoverContent className={cn("w-auto min-w-[140px] p-1")}>
                {addTabOptions.map(({ type, label, icon: Icon }) => (
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
        </div>

        {/* Workspace actions */}
        <div className={cn("flex shrink-0 items-center gap-1.5 pl-2")}>
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
