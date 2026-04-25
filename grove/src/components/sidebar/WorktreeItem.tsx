import { useState, type FormEvent } from "react";
import { GitBranch, Layers, LayersPlus, Loader2, Workflow, X } from "lucide-react";
import type { Worktree } from "../../types";
import { useProjectStore } from "../../store/project";
import type { AiSession, AiTool } from "../../store/terminal";
import { useToast } from "../../store/toast";
import { overlay } from "../../lib/overlay";
import { cn } from "../../lib/cn";
import claudeCodeColor from "../../assets/claudecode-color.png";
import codexColor from "../../assets/codex-color.png";
import { useSidebarLeafActivation } from "../../hooks/useSidebarLeafActivation";
import SidebarLeafItem from "./SidebarLeafItem";
import { Badge } from "../ui/badge";
import { Button, IconButton } from "../ui/button";
import { Input } from "../ui/input";
import { Dialog } from "../ui/dialog";
import {
  useAiWorktreeSessions,
  useWorktreeBell,
} from "./worktree-status";
import SidebarContextMenu from "./SidebarContextMenu";
import { getNoteKey, NoteEmoji } from "./NotePopover";
import { sanitizeBranchName } from "../../lib/git-utils";

interface CreateStackedWorktreeDialogProps {
  close: () => void;
  projectId: string;
  parentWorktree: Worktree;
}

function CreateStackedWorktreeDialog({
  close,
  projectId,
  parentWorktree,
}: CreateStackedWorktreeDialogProps) {
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const addStackedWorktree = useProjectStore((state) => state.addStackedWorktree);
  const { toast } = useToast();

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const nextName = name.trim();
    if (!nextName) {
      return;
    }

    setCreating(true);
    try {
      await addStackedWorktree(projectId, parentWorktree.name, nextName);
      toast("success", `Stacked worktree '${nextName}' created`);
      close();
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open onClose={close} title="Create stacked worktree" className="max-w-sm">
      <form className={cn("space-y-4")} onSubmit={handleSubmit}>
        <div className={cn("space-y-1.5")}>
          <p className={cn("text-sm text-muted-foreground")}>
            Parent
          </p>
          <p className={cn("text-sm font-medium text-foreground")}>
            {parentWorktree.name}
          </p>
        </div>
        <div className={cn("space-y-1.5")}>
          <label className={cn("text-sm text-muted-foreground")} htmlFor="stacked-worktree-name">
            Branch name
          </label>
          <Input
            id="stacked-worktree-name"
            autoFocus
            value={name}
            placeholder="branch name"
            disabled={creating}
            onChange={(event) => setName(sanitizeBranchName(event.target.value))}
          />
        </div>
        <div className={cn("flex justify-end gap-2")}>
          <Button type="button" variant="ghost" size="sm" onClick={close} disabled={creating}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={creating || !name.trim()}>
            {creating ? "Creating..." : "Create"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ── Icon mapping ──

const AI_ICON: Record<AiTool, string> = {
  claude: claudeCodeColor,
  codex: codexColor,
};

// ── AI status icons ──

export function AiStatusIcons({ sessions }: { sessions: AiSession[] }) {
  if (sessions.length === 0) return null;

  return (
    <span
      className={cn("flex shrink-0 items-center gap-1")}
      aria-label={`AI: ${sessions.length} session(s)`}
    >
      {sessions.map(({ tool, status }, i) => (
        <img
          key={i}
          src={AI_ICON[tool]}
          alt={tool}
          className={cn("h-[13px] w-[13px]", {
            "animate-glow": status === "running",
            "animate-glow-claude": status === "running" && tool === "claude",
            "animate-glow-codex": status === "running" && tool === "codex",
            "animate-bounce-dock": status === "attention",
          })}
        />
      ))}
    </span>
  );
}

// ── WorktreeItem ──

interface Props {
  worktree: Worktree;
  projectId: string;
  descendantCount?: number;
}

function WorktreeItem({
  worktree,
  projectId,
  descendantCount = 0,
}: Props) {
  const [removing, setRemoving] = useState(false);
  const isSelected = useProjectStore((s) => s.selectedWorktree?.path === worktree.path);
  const selectWorktree = useProjectStore((s) => s.selectWorktree);
  const removeWorktree = useProjectStore((s) => s.removeWorktree);
  const { toast } = useToast();
  const hasBell = useWorktreeBell(worktree.path);
  const aiSessions = useAiWorktreeSessions(worktree.path);
  const displayName = worktree.branch || worktree.name;
  const isStacked = Boolean(worktree.stackParentName);
  const hasDescendants = descendantCount > 0;
  const noteKey = getNoteKey({ type: "worktree", projectId, worktreeName: worktree.name });
  const handleActivate = useSidebarLeafActivation({
    disabled: removing,
    isSelected,
    onSelect: () => selectWorktree(worktree),
  });

  const handleCreateStacked = () => {
    void overlay.open<void>(({ close }) => (
      <CreateStackedWorktreeDialog
        close={close}
        projectId={projectId}
        parentWorktree={worktree}
      />
    ));
  };

  const handleRemove = async () => {
    const confirmed = await overlay.confirm({
      title: "Remove worktree?",
      description: (
        <>
          Worktree{" "}
          <span className={cn("font-semibold text-foreground")}>{displayName}</span>{" "}
          and its local branch, terminal sessions, and layouts will be removed.
        </>
      ),
      confirmLabel: "Delete",
      variant: "destructive",
    });

    if (!confirmed) return;

    setRemoving(true);
    try {
      await removeWorktree(projectId, worktree.name);
      toast("success", `Worktree '${worktree.name}' removed`);
    } catch {
      setRemoving(false);
    }
  };

  return (
    <SidebarContextMenu path={worktree.path} noteKey={noteKey} noteLabel={displayName}>
      <SidebarLeafItem
        icon={(
          isStacked ? (
            <Layers className={cn("h-[13px] w-[13px] shrink-0", {
              "text-orange-500": hasBell,
            })} />
          ) : (
            <GitBranch className={cn("h-[13px] w-[13px] shrink-0", {
              "text-orange-500": hasBell,
            })} />
          )
        )}
        label={
          <span className={cn("flex min-w-0 items-center gap-2")}>
            <span className={cn("min-w-0 truncate")}>
              {displayName}
              <NoteEmoji noteKey={noteKey} label={displayName} />
            </span>
            {hasDescendants ? (
              <Badge
                variant="outline"
                className={cn("gap-1 px-1.5 py-0 text-[10px]")}
                title={`${descendantCount} stacked child${descendantCount === 1 ? "" : "ren"}`}
                aria-label={`${descendantCount} stacked child${descendantCount === 1 ? "" : "ren"}`}
              >
                <Workflow className={cn("h-3 w-3")} />
                <span>{descendantCount}</span>
              </Badge>
            ) : null}
          </span>
        }
        title={worktree.path}
        isSelected={isSelected}
        disabled={removing}
        onActivate={handleActivate}
        status={<AiStatusIcons sessions={aiSessions} />}
        action={removing ? (
          <Loader2 className={cn("h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground")} />
        ) : (
          <>
            <IconButton
              type="button"
              className={cn("h-4 w-4")}
              onClick={(event) => {
                event.stopPropagation();
                handleCreateStacked();
              }}
              onPointerDown={(event) => event.stopPropagation()}
              disabled={removing}
              title="Create stacked worktree"
            >
              <LayersPlus className={cn("h-3 w-3")} />
            </IconButton>
            <IconButton
              type="button"
              className={cn("h-4 w-4")}
              onClick={(event) => {
                event.stopPropagation();
                void handleRemove();
              }}
              onPointerDown={(event) => event.stopPropagation()}
              disabled={hasDescendants}
              title={hasDescendants ? "Remove stacked children first" : "Remove worktree"}
            >
              <X className={cn("h-3 w-3")} />
            </IconButton>
          </>
        )}
      />
    </SidebarContextMenu>
  );
}

export default WorktreeItem;
