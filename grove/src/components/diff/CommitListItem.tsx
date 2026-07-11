import { GitCommit } from "lucide-react";
import type { CommitInfo } from "../../types";
import { formatCommitTime } from "../../lib/format-time";
import { cn } from "../../lib/cn";

interface Props {
  commit: CommitInfo;
  isSelected: boolean;
  onClick: () => void;
}

export default function CommitListItem({ commit, isSelected, onClick }: Props) {
  return (
    <div
      className={cn("flex items-start gap-3 px-4 py-2 cursor-pointer transition-colors", {
        "bg-selected": isSelected,
        "hover:bg-secondary/30": !isSelected,
      })}
      onClick={onClick}
    >
      <div className="mt-0.5">
        <GitCommit className={cn("h-4 w-4 text-accent")} />
      </div>
      <div className={cn("flex-1 min-w-0")}>
        <p className={cn("truncate text-sm text-foreground")}>{commit.message.split("\n")[0]}</p>
        <div className={cn("mt-1 flex items-baseline gap-2 text-xs text-muted-foreground min-w-0")}>
          <span className={cn("font-mono shrink-0")}>{commit.shortHash}</span>
          <span className="truncate">{commit.author}</span>
          <span className="shrink-0">{formatCommitTime(commit.date)}</span>
        </div>
      </div>
    </div>
  );
}
