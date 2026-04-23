import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { cn } from "../../lib/cn";
import ProjectCategoriesPanel from "../preferences/ProjectCategoriesPanel";
import { usePreferencesUiStore } from "../../store/preferences-ui";

interface Props {
  projectId: string;
  close: () => void;
}

export default function ProjectCategoryDialog({ projectId, close }: Props) {
  const openPreferences = usePreferencesUiStore((state) => state.openPreferences);

  return (
    <Dialog open onClose={close} title="Project Categories" className="max-w-3xl">
      <div className={cn("space-y-5")}>
        <ProjectCategoriesPanel projectId={projectId} managementMode="assign-only" />
        <div className={cn("flex items-center justify-between border-t border-border pt-4")}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              close();
              queueMicrotask(() => openPreferences("categories"));
            }}
          >
            Manage categories
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={close}>
            Done
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
