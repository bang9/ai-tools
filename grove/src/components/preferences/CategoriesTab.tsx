import { cn } from "../../lib/cn";
import ProjectCategoriesPanel from "./ProjectCategoriesPanel";

export default function CategoriesTab() {
  return (
    <div>
      <h3 className={cn("mb-5 text-sm font-semibold text-foreground")}>Project Categories</h3>
      <ProjectCategoriesPanel />
    </div>
  );
}
