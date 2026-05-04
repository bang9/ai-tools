import { FolderTree, ListChecks } from "lucide-react";
import type { DirectoryFileEntry, FileStatus } from "../../types";
import { cn } from "../../lib/cn";
import DirectoryFileList from "./DirectoryFileList";
import FileList from "./FileList";

export type FilePaneMode = "changes" | "directory";

interface Props {
  mode: FilePaneMode;
  onModeChange: (mode: FilePaneMode) => void;
  fileStatuses: FileStatus[];
  directoryFiles: DirectoryFileEntry[];
  directoryFilesLoading: boolean;
  selectedFile: string | null;
  onSelectChangeFile: (path: string | null, staged?: boolean) => void;
  onSelectDirectoryFile: (path: string) => void;
}

export default function DiffFilePane({
  mode,
  onModeChange,
  fileStatuses,
  directoryFiles,
  directoryFilesLoading,
  selectedFile,
  onSelectChangeFile,
  onSelectDirectoryFile,
}: Props) {
  return (
    <div className={cn("flex h-full min-h-0 overflow-hidden")}>
      <div className={cn("min-w-0 flex-1")}>
        {mode === "changes" ? (
          <FileList
            fileStatuses={fileStatuses}
            selectedFile={selectedFile}
            onSelectFile={onSelectChangeFile}
          />
        ) : (
          <DirectoryFileList
            entries={directoryFiles}
            loading={directoryFilesLoading}
            selectedFile={selectedFile}
            onSelectFile={onSelectDirectoryFile}
          />
        )}
      </div>
      <div className={cn("flex w-10 shrink-0 flex-col items-center gap-1 border-l border-border bg-sidebar/80 py-2")}>
        <button
          type="button"
          title="Working changes"
          aria-label="Working changes"
          aria-pressed={mode === "changes"}
          className={cn(
            "flex size-8 items-center justify-center rounded-md border transition-colors",
            {
              "border-accent/30 bg-accent/15 text-accent": mode === "changes",
              "border-transparent text-muted-foreground hover:bg-secondary/50 hover:text-foreground":
                mode !== "changes",
            },
          )}
          onClick={() => onModeChange("changes")}
        >
          <ListChecks className={cn("size-4")} />
        </button>
        <button
          type="button"
          title="Directory & files"
          aria-label="Directory & files"
          aria-pressed={mode === "directory"}
          className={cn(
            "flex size-8 items-center justify-center rounded-md border transition-colors",
            {
              "border-accent/30 bg-accent/15 text-accent": mode === "directory",
              "border-transparent text-muted-foreground hover:bg-secondary/50 hover:text-foreground":
                mode !== "directory",
            },
          )}
          onClick={() => onModeChange("directory")}
        >
          <FolderTree className={cn("size-4")} />
        </button>
      </div>
    </div>
  );
}
