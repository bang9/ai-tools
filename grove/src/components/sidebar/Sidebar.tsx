import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { useProject } from "../../hooks/useProject";
import { useMission } from "../../hooks/useMission";
import { usePanelLayoutStore } from "../../store/panel-layout";
import { usePreferencesStore } from "../../store/preferences";
import { PanelModeSwitch } from "./PanelModeSwitch";
import ProjectTree from "./ProjectTree";
import ProjectCategoryFilterBar from "./ProjectCategoryFilterBar";
import AddProjectDialog from "./AddProjectDialog";
import CreateMissionDialog from "./CreateMissionDialog";
import MissionPanel from "./MissionPanel";
import { IconButton } from "../ui/button";
import { cn } from "../../lib/cn";
import { DEFAULT_PROJECT_CATEGORY_ID, resolveProjectCategoryId } from "../../lib/project-categories";
import { hasFocusedProjects, getFocusedProjects } from "../../lib/project-focus";

function Sidebar() {
  const { projects, cloningProjects, loading } = useProject();
  const { loading: missionsLoading } = useMission();
  const sidebarMode = usePanelLayoutStore((s) => s.sidebarMode);
  const projectCategories = usePreferencesStore((s) => s.projectCategories);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showCreateMissionDialog, setShowCreateMissionDialog] = useState(false);
  const [activeCategoryIds, setActiveCategoryIds] = useState<string[]>([]);
  const [focusViewActive, setFocusViewActive] = useState(false);
  let filteredProjectCount: number;
  if (focusViewActive) {
    filteredProjectCount = getFocusedProjects(projects).length;
  } else if (activeCategoryIds.length === 0) {
    filteredProjectCount = projects.length;
  } else {
    filteredProjectCount = projects.filter((project) =>
      activeCategoryIds.includes(resolveProjectCategoryId(project.categoryId)),
    ).length;
  }

  const isProjectsMode = sidebarMode === "projects";
  const addButtonTitle = isProjectsMode ? "Add project" : "Create mission";

  const handleAddButtonClick = () => {
    if (isProjectsMode) {
      setShowAddDialog(true);
      return;
    }

    setShowCreateMissionDialog(true);
  };

  useEffect(() => {
    setShowAddDialog(false);
    setShowCreateMissionDialog(false);
  }, [sidebarMode]);

  useEffect(() => {
    const validIds = new Set([
      DEFAULT_PROJECT_CATEGORY_ID,
      ...projectCategories.map((category) => category.id),
    ]);

    setActiveCategoryIds((current) => {
      const next = current.filter((id) => validIds.has(id));
      return next.length === current.length ? current : next;
    });
  }, [projectCategories]);

  useEffect(() => {
    if (focusViewActive && !hasFocusedProjects(projects)) {
      setFocusViewActive(false);
    }
  }, [focusViewActive, projects]);

  let content: React.ReactNode;
  if (isProjectsMode) {
    if (loading) {
      content = (
        <div className={cn("space-y-3 px-1.5")}>
          {[1, 2, 3].map((i) => (
            <div key={i} className="space-y-1.5">
              <div className={cn("px-2.5 py-2")}>
                <div className={cn("skeleton h-4")} style={{ width: "100%" }} />
              </div>
              <div className={cn("ml-5 border-l border-border pl-3 space-y-1")}>
                <div className={cn("px-2 py-1")}>
                  <div className={cn("skeleton h-3.5")} style={{ width: "100%" }} />
                </div>
              </div>
            </div>
          ))}
        </div>
      );
    } else if (projects.length === 0 && cloningProjects.length === 0) {
      content = (
        <div className={cn("flex flex-col items-center justify-center gap-2 px-3 py-10")}>
          <span className={cn("text-xs text-muted-foreground")}>No projects yet</span>
          <button
            className={cn("text-xs text-accent hover:underline")}
            onClick={() => setShowAddDialog(true)}
          >
            Add a project
          </button>
        </div>
      );
    } else if (filteredProjectCount === 0) {
      content = (
        <div className={cn("flex flex-col items-center justify-center gap-2 px-3 py-10")}>
          <span className={cn("text-xs text-muted-foreground")}>
            No projects in the selected categories
          </span>
          <button
            className={cn("text-xs text-accent hover:underline")}
            onClick={() => setActiveCategoryIds([])}
          >
            Clear filter
          </button>
        </div>
      );
    } else {
      content = (
        <ProjectTree
          projects={projects}
          cloningProjects={cloningProjects}
          activeCategoryIds={activeCategoryIds}
          focusViewActive={focusViewActive}
        />
      );
    }
  } else if (missionsLoading) {
    content = (
      <div className={cn("space-y-3 px-1.5")}>
        {[1, 2, 3].map((i) => (
          <div key={i} className={cn("px-2.5 py-2")}>
            <div className={cn("skeleton h-4")} style={{ width: "100%" }} />
          </div>
        ))}
      </div>
    );
  } else {
    content = <MissionPanel />;
  }

  return (
    <div className={cn("flex h-full flex-col bg-sidebar")}>
      <div className={cn("border-b border-border/70 px-2.5 pb-1.5 pt-2")}>
        <div className={cn("flex items-center gap-2")}>
          <PanelModeSwitch className={cn("flex-1")} />
          <IconButton
            onClick={handleAddButtonClick}
            title={addButtonTitle}
            className={cn(
              "h-8 w-8 shrink-0 cursor-pointer rounded-lg border border-border/70 bg-[var(--color-bg-tertiary)]/70 hover:bg-[var(--color-bg-secondary)]",
            )}
          >
            <Plus className={cn("h-3 w-3")} />
          </IconButton>
        </div>
      </div>

      {showAddDialog && (
        <AddProjectDialog onClose={() => setShowAddDialog(false)} />
      )}
      {showCreateMissionDialog && (
        <CreateMissionDialog onClose={() => setShowCreateMissionDialog(false)} />
      )}

      {isProjectsMode && projects.length > 0 && (
        <ProjectCategoryFilterBar
          projects={projects}
          activeCategoryIds={activeCategoryIds}
          focusViewActive={focusViewActive}
          onToggleCategory={(categoryId) => {
            setFocusViewActive(false);
            setActiveCategoryIds((current) =>
              current.includes(categoryId)
                ? current.filter((id) => id !== categoryId)
                : [...current, categoryId],
            );
          }}
          onClearCategories={() => setActiveCategoryIds([])}
          onSelectFocus={() =>
            setFocusViewActive((active) => {
              const next = !active;
              if (next) {
                setActiveCategoryIds([]);
              }
              return next;
            })
          }
        />
      )}

      <div className={cn("flex-1 overflow-y-auto px-1.5 pb-2.5 pt-1.5")}>{content}</div>
    </div>
  );
}

export default Sidebar;
