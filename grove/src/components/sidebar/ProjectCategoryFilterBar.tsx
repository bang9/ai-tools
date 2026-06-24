import type { CSSProperties } from "react";
import { useState } from "react";
import { X } from "lucide-react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import type { Project, ProjectCategory } from "../../types";
import { cn } from "../../lib/cn";
import {
  DEFAULT_PROJECT_CATEGORY,
  colorWithAlpha,
  getProjectCategoryBadgeStyle,
  reorderProjectCategories,
  resolveProjectCategoryId,
  ProjectCategoryIconGlyph,
} from "../../lib/project-categories";
import { usePreferencesStore } from "../../store/preferences";

interface Props {
  projects: Project[];
  activeCategoryIds: string[];
  onToggleCategory: (categoryId: string) => void;
  onClearCategories: () => void;
}

function categoryBadgeClassName(isActive: boolean): string {
  return cn(
    "inline-flex h-7 box-border items-center justify-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
    {
      "shadow-none": isActive,
      "opacity-90": !isActive,
    },
  );
}

function activeBadgeStyle(category: ProjectCategory, isActive: boolean): CSSProperties {
  const baseStyle = getProjectCategoryBadgeStyle(category.color);
  if (!isActive) {
    return baseStyle;
  }
  return {
    ...baseStyle,
    borderColor: colorWithAlpha(category.color, 0.52),
    backgroundColor: colorWithAlpha(category.color, 0.2),
    boxShadow: `0 0 0 1px ${colorWithAlpha(category.color, 0.18)}, inset 0 0 0 1px rgba(255,255,255,0.14)`,
  };
}

interface CategoryBadgeProps {
  category: ProjectCategory;
  projectCount: number;
  isActive: boolean;
  onToggle: () => void;
}

function CategoryBadge({ category, projectCount, isActive, onToggle }: CategoryBadgeProps) {
  return (
    <button
      type="button"
      className={cn(categoryBadgeClassName(isActive))}
      style={activeBadgeStyle(category, isActive)}
      onClick={onToggle}
      title={
        isActive
          ? `${category.name} (${projectCount}) - click to clear filter`
          : `Filter ${category.name} (${projectCount})`
      }
      aria-pressed={isActive}
    >
      <ProjectCategoryIconGlyph icon={category.icon} className={cn("size-3.5")} />
      <span className={cn("whitespace-nowrap")}>{category.name}</span>
    </button>
  );
}

interface SortableCategoryBadgeProps extends CategoryBadgeProps {
  id: string;
}

function SortableCategoryBadge({ id, ...badgeProps }: SortableCategoryBadgeProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    touchAction: "none",
  };
  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <CategoryBadge {...badgeProps} />
    </div>
  );
}

export default function ProjectCategoryFilterBar({
  projects,
  activeCategoryIds,
  onToggleCategory,
  onClearCategories,
}: Props) {
  const projectCategories = usePreferencesStore((state) => state.projectCategories);
  const setProjectCategories = usePreferencesStore((state) => state.setProjectCategories);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  if (projectCategories.length === 0) {
    return null;
  }

  const countFor = (categoryId: string) =>
    projects.filter(
      (project) => resolveProjectCategoryId(project.categoryId) === categoryId,
    ).length;

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveDragId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const next = reorderProjectCategories(
      projectCategories,
      active.id as string,
      over.id as string,
    );
    if (next !== projectCategories) {
      void setProjectCategories(next);
    }
  };

  return (
    <div className={cn("border-b border-border/60 px-2.5 py-2")}>
      <div
        className={cn(
          "overflow-x-auto p-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        )}
      >
        <div className={cn("flex min-w-max items-center gap-2")}>
          <CategoryBadge
            category={DEFAULT_PROJECT_CATEGORY}
            projectCount={countFor(DEFAULT_PROJECT_CATEGORY.id)}
            isActive={activeCategoryIds.includes(DEFAULT_PROJECT_CATEGORY.id)}
            onToggle={() => onToggleCategory(DEFAULT_PROJECT_CATEGORY.id)}
          />

          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToHorizontalAxis]}
            onDragStart={(event) => setActiveDragId(event.active.id as string)}
            onDragEnd={handleDragEnd}
            onDragCancel={() => setActiveDragId(null)}
          >
            <SortableContext
              items={projectCategories.map((category) => category.id)}
              strategy={horizontalListSortingStrategy}
            >
              {projectCategories.map((category) => (
                <SortableCategoryBadge
                  key={category.id}
                  id={category.id}
                  category={category}
                  projectCount={countFor(category.id)}
                  isActive={
                    activeDragId !== category.id &&
                    activeCategoryIds.includes(category.id)
                  }
                  onToggle={() => onToggleCategory(category.id)}
                />
              ))}
            </SortableContext>
          </DndContext>

          {activeCategoryIds.length > 1 && (
            <button
              type="button"
              className={cn(
                "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border/80 bg-background/90 text-muted-foreground transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                "hover:bg-secondary/40 hover:text-foreground",
              )}
              onClick={onClearCategories}
              title="Clear all category filters"
              aria-label="Clear all category filters"
            >
              <X className={cn("size-3.5")} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
