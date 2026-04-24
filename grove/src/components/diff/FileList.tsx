import { FileText } from "lucide-react";
import type { FileStatus } from "../../types";
import { cn } from "../../lib/cn";

interface Props {
  fileStatuses: FileStatus[];
  selectedFile: string | null;
  onSelectFile: (path: string | null) => void;
}

export default function FileList({
  fileStatuses,
  selectedFile,
  onSelectFile,
}: Props) {
  if (fileStatuses.length === 0) {
    return (
      <div className={cn("flex items-center justify-center h-full text-sm text-muted-foreground")}>
        No changes
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col h-full overflow-hidden")}>
      <div className={cn("flex items-center gap-2 px-4 h-9 shrink-0 border-b border-border")}>
        <span className={cn("text-xs font-medium uppercase tracking-wider text-muted-foreground")}>
          Files
        </span>
        <span className={cn("rounded-full bg-accent/20 px-2 py-0.5 text-xs font-medium text-accent")}>
          {fileStatuses.length}
        </span>
      </div>
      <div className={cn("flex-1 overflow-y-auto")}>
        {fileStatuses.map((file) => (
          <div
            key={file.path}
            className={cn(
              "flex w-full items-center gap-2 px-4 py-1.5 cursor-pointer text-sm transition-colors",
              {
                "bg-selected": selectedFile === file.path,
                "text-muted-foreground hover:bg-secondary/30 hover:text-foreground":
                  selectedFile !== file.path,
              },
            )}
            onClick={() => onSelectFile(file.path)}
          >
            <FileText className={cn("h-3.5 w-3.5 shrink-0")} />
            <span className={cn("min-w-0 truncate", {
              "font-medium": selectedFile === file.path,
            })}>
              {file.path}
            </span>
            <span
              className={cn("ml-auto shrink-0 text-xs font-medium uppercase", {
                "text-success": file.status === "added" || file.status === "untracked",
                "text-warning": file.status === "modified",
                "text-destructive": file.status === "deleted",
                "text-orange-400": file.status === "conflicted",
              })}
            >
              {file.status[0].toUpperCase()}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
