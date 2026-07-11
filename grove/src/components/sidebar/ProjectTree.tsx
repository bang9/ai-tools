import { useState, useMemo, useCallback, useEffect, type CSSProperties } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight } from "lucide-react";
import {
  DndContext,
  closestCenter,
  DragOverlay,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { restrictToVerticalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
import { usePointerDragSensors } from "../ui/sortable";
import type { Project, CloningProject } from "../../types";
import { useProjectStore } from "../../store/project";
import { usePreferencesStore } from "../../store/preferences";
import { cn } from "../../lib/cn";
import { resolveProjectCategoryId } from "../../lib/project-categories";
import {
  applyOrgProjectOrder,
  groupProjectsByOrg,
  moveProjectOrg,
  orderProjectOrgGroups,
} from "../../lib/project-view";
import ProjectItem from "./ProjectItem";
import CloningProjectItem from "./CloningProjectItem";
import { Button, IconButton } from "../ui/button";

interface Props {
  projects: Project[];
  cloningProjects: CloningProject[];
  activeCategoryIds?: string[];
  focusViewActive?: boolean;
}

interface ProjectOrgSectionProps {
  org: string;
  projects: Project[];
  collapsed: boolean;
  onToggle: () => void;
  onReorder: (projectIds: string[]) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  sortingEnabled: boolean;
}

interface SortableProjectListProps {
  projects: Project[];
  onReorder: (projectIds: string[]) => void;
  showOrgPrefix?: boolean;
  className?: string;
  sortable?: boolean;
}

type DocumentWithViewTransition = Document & {
  startViewTransition?: (update: () => void) => unknown;
};

function getProjectOrgTransitionName(org: string): string {
  const slug =
    org
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "org";

  let hash = 0;
  for (const char of org) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }

  return `project-org-${slug}-${hash.toString(36)}`;
}

function startProjectOrgReorderTransition(update: () => void) {
  if (typeof document === "undefined" || typeof window === "undefined") {
    update();
    return;
  }

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    update();
    return;
  }

  const startViewTransition = (document as DocumentWithViewTransition).startViewTransition;
  if (!startViewTransition) {
    update();
    return;
  }

  try {
    startViewTransition.call(document, update);
  } catch {
    update();
  }
}

function SortableProjectList({
  projects,
  onReorder,
  showOrgPrefix = true,
  className,
  sortable = true,
}: SortableProjectListProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const projectIds = useMemo(() => projects.map((project) => project.id), [projects]);
  const sensors = usePointerDragSensors();

  const activeProject = useMemo(
    () => (activeId ? (projects.find((project) => project.id === activeId) ?? null) : null),
    [activeId, projects],
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveId(null);
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = projectIds.indexOf(active.id as string);
      const newIndex = projectIds.indexOf(over.id as string);
      if (oldIndex === -1 || newIndex === -1) return;

      onReorder(arrayMove(projectIds, oldIndex, newIndex));
    },
    [onReorder, projectIds],
  );

  const handleDragCancel = useCallback(() => {
    setActiveId(null);
  }, []);

  if (!sortable) {
    return (
      <div className={cn("space-y-1 py-0.5", className)}>
        {projects.map((project) => (
          <ProjectItem key={project.id} project={project} showOrgPrefix={showOrgPrefix} />
        ))}
      </div>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <SortableContext items={projectIds} strategy={verticalListSortingStrategy}>
        <div className={cn("space-y-1 py-0.5", className)}>
          {projects.map((project) => (
            <ProjectItem key={project.id} project={project} showOrgPrefix={showOrgPrefix} />
          ))}
        </div>
      </SortableContext>
      <DragOverlay>
        {activeProject ? (
          <ProjectItem project={activeProject} showOrgPrefix={showOrgPrefix} />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function ProjectOrgSection({
  org,
  projects,
  collapsed,
  onToggle,
  onReorder,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  sortingEnabled,
}: ProjectOrgSectionProps) {
  const transitionStyle = {
    viewTransitionName: getProjectOrgTransitionName(org),
  } as CSSProperties;

  return (
    <div className={cn("px-1.5")} style={transitionStyle}>
      <div className={cn("group flex items-center gap-1")}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            "h-auto min-w-0 flex-1 justify-start gap-2 rounded-lg border-0 px-2.5 py-1.5 text-[13px] transition-all duration-150",
            "cursor-pointer select-none text-foreground hover:bg-secondary/50 hover:text-foreground",
          )}
          onClick={onToggle}
        >
          {collapsed ? (
            <ChevronRight className={cn("h-[15px] w-[15px] shrink-0 text-muted-foreground")} />
          ) : (
            <ChevronDown className={cn("h-[15px] w-[15px] shrink-0 text-muted-foreground")} />
          )}
          <span className={cn("min-w-0 flex-1 truncate text-left font-medium")}>{org}</span>
        </Button>

        <div className={cn("flex shrink-0 items-center gap-1 pr-1")}>
          <span className={cn("shrink-0 text-[11px] text-muted-foreground")}>
            {projects.length}
          </span>
          {sortingEnabled && (
            <div
              className={cn(
                "flex w-[44px] items-center justify-end gap-0.5 opacity-0 transition-opacity",
                "group-hover:opacity-100 group-focus-within:opacity-100",
              )}
            >
              <IconButton
                className={cn("h-5 w-5 disabled:opacity-30")}
                onClick={(e) => {
                  e.stopPropagation();
                  onMoveUp();
                }}
                disabled={!canMoveUp}
                title="Move group up"
              >
                <ArrowUp className={cn("h-[11px] w-[11px]")} />
              </IconButton>
              <IconButton
                className={cn("h-5 w-5 disabled:opacity-30")}
                onClick={(e) => {
                  e.stopPropagation();
                  onMoveDown();
                }}
                disabled={!canMoveDown}
                title="Move group down"
              >
                <ArrowDown className={cn("h-[11px] w-[11px]")} />
              </IconButton>
            </div>
          )}
        </div>
      </div>

      <div
        className={cn("grid transition-[grid-template-rows] duration-200 ease-out", {
          "grid-rows-[1fr]": !collapsed,
          "grid-rows-[0fr]": collapsed,
        })}
      >
        <div className={cn("overflow-hidden")}>
          <SortableProjectList
            projects={projects}
            onReorder={onReorder}
            showOrgPrefix={false}
            className={cn("ml-4 border-l border-border/80 pl-2")}
            sortable={sortingEnabled}
          />
        </div>
      </div>
    </div>
  );
}

function ProjectTree({
  projects,
  cloningProjects,
  activeCategoryIds = [],
  focusViewActive = false,
}: Props) {
  const projectViewMode = usePreferencesStore((s) => s.projectViewMode);
  const preferencesLoaded = usePreferencesStore((s) => s.loaded);
  const collapsedProjectOrgs = usePreferencesStore((s) => s.collapsedProjectOrgs);
  const projectOrgOrder = usePreferencesStore((s) => s.projectOrgOrder);
  const setProjectOrgCollapsed = usePreferencesStore((s) => s.setProjectOrgCollapsed);
  const setProjectOrgOrder = usePreferencesStore((s) => s.setProjectOrgOrder);
  const reorderProjects = useProjectStore((s) => s.reorderProjects);
  const sortingEnabled = !focusViewActive && activeCategoryIds.length === 0;

  const allOrgGroups = useMemo(() => groupProjectsByOrg(projects), [projects]);
  const orderedAllOrgGroups = useMemo(
    () => orderProjectOrgGroups(allOrgGroups, projectOrgOrder),
    [allOrgGroups, projectOrgOrder],
  );
  const filteredProjects = useMemo(() => {
    if (focusViewActive) {
      return projects.filter((project) => project.focused);
    }
    if (activeCategoryIds.length === 0) {
      return projects;
    }
    return projects.filter((project) =>
      activeCategoryIds.includes(resolveProjectCategoryId(project.categoryId)),
    );
  }, [focusViewActive, activeCategoryIds, projects]);
  const filteredOrgGroups = useMemo(
    () => orderProjectOrgGroups(groupProjectsByOrg(filteredProjects), projectOrgOrder),
    [filteredProjects, projectOrgOrder],
  );
  const visibleOrgIds = useMemo(
    () => orderedAllOrgGroups.map((group) => group.org),
    [orderedAllOrgGroups],
  );
  const collapsedOrgSet = useMemo(() => new Set(collapsedProjectOrgs), [collapsedProjectOrgs]);

  useEffect(() => {
    if (!preferencesLoaded) return;
    const nextOrgOrder = projectOrgOrder.filter((org) => visibleOrgIds.includes(org));
    if (
      nextOrgOrder.length === projectOrgOrder.length &&
      nextOrgOrder.every((org, index) => org === projectOrgOrder[index])
    ) {
      return;
    }

    setProjectOrgOrder(nextOrgOrder);
  }, [preferencesLoaded, projectOrgOrder, setProjectOrgOrder, visibleOrgIds]);

  const handleOrgReorder = useCallback(
    (org: string, reorderedOrgProjectIds: string[]) => {
      const reorderedIds = applyOrgProjectOrder(projects, org, reorderedOrgProjectIds);
      reorderProjects(reorderedIds);
    },
    [projects, reorderProjects],
  );

  const handleMoveOrg = useCallback(
    (org: string, direction: "up" | "down") => {
      const nextOrder = moveProjectOrg(visibleOrgIds, org, direction);
      if (nextOrder.every((value, index) => value === visibleOrgIds[index])) {
        return;
      }
      startProjectOrgReorderTransition(() => {
        setProjectOrgOrder(nextOrder);
      });
    },
    [setProjectOrgOrder, visibleOrgIds],
  );

  return (
    <>
      {projectViewMode === "group-by-orgs" ? (
        <div className={cn("space-y-1 py-0.5")}>
          {filteredOrgGroups.map((group, index) => (
            <ProjectOrgSection
              key={group.org}
              org={group.org}
              projects={group.projects}
              collapsed={collapsedOrgSet.has(group.org)}
              onToggle={() => setProjectOrgCollapsed(group.org, !collapsedOrgSet.has(group.org))}
              onReorder={(projectIds) => handleOrgReorder(group.org, projectIds)}
              canMoveUp={index > 0}
              canMoveDown={index < filteredOrgGroups.length - 1}
              onMoveUp={() => handleMoveOrg(group.org, "up")}
              onMoveDown={() => handleMoveOrg(group.org, "down")}
              sortingEnabled={sortingEnabled}
            />
          ))}
          {sortingEnabled &&
            cloningProjects.map((cp) => <CloningProjectItem key={cp.id} project={cp} />)}
        </div>
      ) : (
        <>
          <SortableProjectList
            projects={filteredProjects}
            onReorder={reorderProjects}
            sortable={sortingEnabled}
          />
          {sortingEnabled && cloningProjects.length > 0 && (
            <div className={cn("mt-1 space-y-1")}>
              {cloningProjects.map((cp) => (
                <CloningProjectItem key={cp.id} project={cp} />
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}

export default ProjectTree;
