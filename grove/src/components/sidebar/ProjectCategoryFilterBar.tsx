import type { Project } from "../../types";
import { X } from "lucide-react";
import { cn } from "../../lib/cn";
import {
  colorWithAlpha,
  getProjectCategories,
  getProjectCategoryBadgeStyle,
  ProjectCategoryIconGlyph,
  resolveProjectCategoryId,
} from "../../lib/project-categories";
import { usePreferencesStore } from "../../store/preferences";

interface Props {
  projects: Project[];
  activeCategoryIds: string[];
  onToggleCategory: (categoryId: string) => void;
  onClearCategories: () => void;
}

export default function ProjectCategoryFilterBar({
  projects,
  activeCategoryIds,
  onToggleCategory,
  onClearCategories,
}: Props) {
  const projectCategories = usePreferencesStore((state) => state.projectCategories);

  if (projectCategories.length === 0) {
    return null;
  }

  const categories = getProjectCategories(projectCategories);

  return (
    <div className={cn("border-b border-border/60 px-2.5 py-2")}>
      <div
        className={cn(
          "overflow-x-auto p-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        )}
      >
        <div className={cn("flex min-w-max items-center gap-2")}>
          {categories.map((category) => {
            const isActive = activeCategoryIds.includes(category.id);
            const projectCount = projects.filter(
              (project) =>
                resolveProjectCategoryId(project.categoryId) === category.id,
            ).length;
            const baseStyle = getProjectCategoryBadgeStyle(category.color);
            const activeStyle = isActive
              ? {
                  ...baseStyle,
                  borderColor: colorWithAlpha(category.color, 0.52),
                  backgroundColor: colorWithAlpha(category.color, 0.2),
                  boxShadow: `0 0 0 1px ${colorWithAlpha(category.color, 0.18)}, inset 0 0 0 1px rgba(255,255,255,0.14)`,
                }
              : baseStyle;

            return (
              <button
                key={category.id}
                type="button"
                className={cn(
                  "inline-flex h-7 box-border items-center justify-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                  {
                    "shadow-none": isActive,
                    "opacity-90": !isActive,
                  },
                )}
                style={activeStyle}
                onClick={() => onToggleCategory(category.id)}
                title={
                  isActive
                    ? `${category.name} (${projectCount}) - click to clear filter`
                    : `Filter ${category.name} (${projectCount})`
                }
                aria-pressed={isActive}
              >
                <ProjectCategoryIconGlyph
                  icon={category.icon}
                  className={cn("size-3.5")}
                />
                <span className={cn("whitespace-nowrap")}>{category.name}</span>
              </button>
            );
          })}

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
