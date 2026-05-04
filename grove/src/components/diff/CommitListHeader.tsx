import { GitMerge } from "lucide-react";
import { IconButton } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { cn } from "../../lib/cn";


interface Props {
  behindCount: number;
  branchName: string | null;
  merging: boolean;
  onMerge: () => void;
}

export default function CommitListHeader({
  behindCount,
  branchName,
  merging,
  onMerge,
}: Props) {
  return (
    <div className={cn("flex items-center border-b border-border px-4 h-9 select-none")}>
      <div className={cn("flex min-w-0 items-center gap-2")}>
        <span className={cn("text-xs font-medium uppercase tracking-wider text-muted-foreground")}>
          Commits
        </span>
        {branchName && (
          <span
            className={cn(
              "max-w-[160px] truncate rounded-full border border-border bg-secondary/70 px-2 py-0.5",
              "text-[11px] font-medium leading-none text-foreground/80",
            )}
            title={branchName}
          >
            {branchName}
          </span>
        )}
      </div>
      {behindCount > 0 && (
        <div className={cn("ml-auto flex shrink-0 items-center gap-1.5")}>
          <span className={cn("rounded-full bg-accent/20 px-2 py-0.5 text-xs font-medium text-accent")}>
            {"\u2193"}{behindCount}
          </span>
          <IconButton
            onClick={onMerge}
            disabled={merging}
            title="Merge default branch"
          >
            {merging ? (
              <Spinner className="size-3.5" />
            ) : (
              <GitMerge className="size-3.5" />
            )}
          </IconButton>
        </div>
      )}
    </div>
  );
}
