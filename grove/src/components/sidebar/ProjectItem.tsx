import { memo, useEffect, useState } from "react";
import {
  X,
  GitBranch,
  Pencil,
  Settings,
  Github,
} from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Project } from "../../types";
import { useProjectStore } from "../../store/project";
import { usePreferencesStore } from "../../store/preferences";
import { useToast } from "../../store/toast";
import { overlay } from "../../lib/overlay";
import { runCommand } from "../../lib/command";
import { openExternal } from "../../lib/platform";
import ProjectSettingsDialog from "./ProjectSettingsDialog";
import ProjectCategoryDialog from "./ProjectCategoryDialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../ui/context-menu";
import DefaultBranchItem from "./DefaultBranchItem";
import WorktreeItem from "./WorktreeItem";
import { IconButton } from "../ui/button";
import { cn } from "../../lib/cn";
import { sanitizeBranchName } from "../../lib/git-utils";
import { getProjectDisplayName } from "../../lib/project-view";
import { getGitHubRepoUrl } from "../../lib/project-remote";
import { buildWorktreeTree, type WorktreeTreeNode } from "../../lib/worktree-tree";
import {
  ProjectCategoryIconGlyph,
  resolveProjectCategory,
} from "../../lib/project-categories";

interface Props {
  project: Project;
  showOrgPrefix?: boolean;
}

interface WorktreeTreeListProps {
  projectId: string;
  nodes: WorktreeTreeNode[];
}

function WorktreeTreeList({ projectId, nodes }: WorktreeTreeListProps) {
  return nodes.map((node) => (
    <div key={node.worktree.path}>
      <WorktreeItem
        worktree={node.worktree}
        projectId={projectId}
        descendantCount={node.descendantCount}
      />
      {node.children.length > 0 ? (
        <div className={cn("ml-4 border-l border-border/60 pl-2")}>
          <WorktreeTreeList projectId={projectId} nodes={node.children} />
        </div>
      ) : null}
    </div>
  ));
}

const ProjectItem = memo(function ProjectItem({
  project,
  showOrgPrefix = true,
}: Props) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: project.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const toggleCollapse = useProjectStore((s) => s.toggleProjectCollapse);
  const expanded = !project.collapsed;
  const [addingState, setAddingState] = useState<"closed" | "open" | "creating">("closed");
  const adding = addingState !== "closed";
  const addingLoading = addingState === "creating";
  const [worktreeName, setWorktreeName] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const addWorktree = useProjectStore((s) => s.addWorktree);
  const removeProject = useProjectStore((s) => s.removeProject);
  const renameProject = useProjectStore((s) => s.renameProject);
  const projectCategories = usePreferencesStore((s) => s.projectCategories);
  const { toast } = useToast();

  const handleAddWorktree = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = worktreeName.trim();
    if (!name) return;
    setAddingState("creating");
    try {
      await addWorktree(project.id, name);
      toast("success", `Worktree '${name}' created`);
      setWorktreeName("");
      setAddingState("closed");
    } catch {
      setAddingState((prev) => (prev === "creating" ? "open" : prev));
    }
  };

  useEffect(() => {
    if (addingState !== "creating") return;
    const targetName = worktreeName.trim();
    if (!targetName) return;
    if (project.worktrees.some((w) => w.name === targetName)) {
      setAddingState("closed");
      setWorktreeName("");
    }
  }, [addingState, worktreeName, project.worktrees]);

  const displayName = getProjectDisplayName(project, { showOrgPrefix });
  const githubRepoUrl = getGitHubRepoUrl(project.url);
  const projectCategory = resolveProjectCategory(project.categoryId, projectCategories);
  const worktreeTree = buildWorktreeTree(project.worktrees);

  const handleStartRename = (e: React.MouseEvent) => {
    e.stopPropagation();
    setRenameValue(displayName);
    setRenaming(true);
  };

  const handleRename = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = renameValue.trim() || project.repo;
    try {
      await renameProject(project.id, name);
    } catch {
      // Toasts are handled by the command layer.
    }
    setRenaming(false);
  };

  const handleProjectSettings = () => {
    overlay.open<boolean>(({ resolve, close }) => (
      <ProjectSettingsDialog projectId={project.id} resolve={resolve} close={close} />
    ));
  };

  const handleProjectCategory = (e: React.MouseEvent | React.PointerEvent) => {
    e.stopPropagation();
    if ("type" in e && e.type === "pointerdown") {
      return;
    }
    overlay.open<boolean>(({ close }) => (
      <ProjectCategoryDialog projectId={project.id} close={close} />
    ));
  };

  const handleOpenInGitHub = () => {
    if (!githubRepoUrl) {
      return;
    }

    void runCommand(() => openExternal(githubRepoUrl), {
      errorToast: "Failed to open GitHub repository",
    });
  };

  const handleRemoveProject = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const confirmed = await overlay.confirm({
      title: "Remove project?",
      description: (
        <>
          <p>
            <span className={cn("font-semibold text-foreground")}>
              {project.org}/{project.repo}
            </span>{" "}
            project folder and all worktrees will be deleted.
          </p>
          <p className={cn("text-xs text-muted-foreground/70")}>
            This removes the hidden source repository too. Use sync source if
            you only want to reset the source repo to the remote default
            branch.
          </p>
        </>
      ),
      confirmLabel: "Delete project",
      variant: "destructive",
    });

    if (!confirmed) return;

    try {
      await removeProject(project.id);
      toast("success", `Project '${project.repo}' removed`);
    } catch {
      // Toasts are handled by the command layer.
    }
  };

  return (
    <div ref={setNodeRef} style={style} className={cn("px-1.5")}>
      <ContextMenu>
      <ContextMenuTrigger asChild>
      <div
        className={cn(
          "group flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] leading-5 text-foreground transition-all duration-150 cursor-pointer select-none hover:bg-secondary/50",
        )}
        onClick={() => toggleCollapse(project.id)}
        {...attributes}
        {...listeners}
      >
        <button
          type="button"
          className={cn(
            "relative inline-flex shrink-0 cursor-pointer items-center justify-center rounded-md focus-visible:outline-none",
            "before:content-[''] before:absolute before:-inset-1 before:rounded-md before:border before:border-border/80 before:bg-background/95 before:opacity-0 before:shadow-sm before:transition-opacity",
            "hover:before:opacity-100 focus-visible:before:opacity-100",
            {
              "text-accent": expanded,
              "text-muted-foreground": !expanded,
            },
          )}
          onClick={handleProjectCategory}
          onPointerDown={handleProjectCategory}
          title={`Manage ${projectCategory.name} category`}
        >
          <span
            className={cn(
              "relative z-[1] inline-flex h-[15px] w-[15px] items-center justify-center",
            )}
          >
            <ProjectCategoryIconGlyph
              icon={projectCategory.icon}
              className={cn("h-[15px] w-[15px] shrink-0")}
            />
          </span>
        </button>
        {renaming ? (
          <form onSubmit={handleRename} className={cn("flex-1 min-w-0")}>
            <input
              className={cn(
                "w-full bg-transparent text-[13px] font-medium text-foreground outline-none",
                "placeholder:text-muted-foreground/50",
              )}
              type="text"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              autoFocus
              onBlur={() => setRenaming(false)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setRenaming(false);
              }}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
            />
          </form>
        ) : (
          <span className={cn("truncate font-medium")} title={`${project.org}/${project.repo}`}>
            {displayName}
          </span>
        )}
        <div className={cn("ml-auto hidden shrink-0 items-center group-hover:flex")}>
          <IconButton
            className={cn("h-5 w-5")}
            onClick={handleStartRename}
            onPointerDown={(e) => e.stopPropagation()}
            title="Rename project"
          >
            <Pencil className={cn("h-[11px] w-[11px]")} />
          </IconButton>
          <IconButton
            className={cn("h-5 w-5")}
            onClick={handleRemoveProject}
            onPointerDown={(e) => e.stopPropagation()}
            title="Remove project"
          >
            <X className={cn("h-[11px] w-[11px]")} />
          </IconButton>
        </div>
      </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={handleProjectSettings}>
          <Settings className={cn("mr-1.5 h-3.5 w-3.5")} />
          Project Settings
        </ContextMenuItem>
        {githubRepoUrl && (
          <ContextMenuItem onSelect={handleOpenInGitHub}>
            <Github className={cn("mr-1.5 h-3.5 w-3.5")} />
            Open in GitHub
          </ContextMenuItem>
        )}
      </ContextMenuContent>
      </ContextMenu>

      <div className={cn(
        "grid transition-[grid-template-rows] duration-200 ease-out",
        { "grid-rows-[1fr]": expanded, "grid-rows-[0fr]": !expanded },
      )}>
        <div className={cn("overflow-hidden")}>
          <div className={cn("ml-4 border-l border-border/80 pl-2")}>
            <DefaultBranchItem project={project} />
            {/* Phase 2: 드래그 재정렬 — <WorktreeItem>을 드래그 가능하게 만들고,
                드래그 완료 시 setWorktreeOrder(project.id, newOrder) 호출.
                react-dnd 또는 @dnd-kit/sortable 권장. */}
            <WorktreeTreeList projectId={project.id} nodes={worktreeTree} />
            {adding ? (
              <form onSubmit={handleAddWorktree}>
                <div className={cn("relative flex items-center gap-2 rounded-md px-2 py-1")}>
                  <GitBranch className={cn("h-[13px] w-[13px] shrink-0 text-muted-foreground")} />
                  <input
                    className={cn(
                      "min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none",
                      "placeholder:text-muted-foreground/50 disabled:opacity-50",
                    )}
                    type="text"
                    placeholder="branch name"
                    value={worktreeName}
                    onChange={(e) => setWorktreeName(sanitizeBranchName(e.target.value))}
                    autoFocus
                    disabled={addingLoading}
                    onBlur={() => {
                      if (!worktreeName.trim() && !addingLoading) setAddingState("closed");
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Escape" && !addingLoading) setAddingState("closed");
                    }}
                  />
                  {addingLoading && (
                    <span className={cn("text-xs text-muted-foreground animate-pulse shrink-0")}>
                      Creating...
                    </span>
                  )}
                </div>
              </form>
            ) : (
              <button
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1 text-[13px] transition-colors",
                  "text-muted-foreground hover:bg-secondary/50 hover:text-foreground",
                )}
                onClick={() => setAddingState("open")}
              >
                <span>Add worktree</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

export default ProjectItem;
