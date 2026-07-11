import { useCallback, useState } from "react";
import { Copy, File, FolderOpen, Globe, RotateCw, WrapText } from "lucide-react";
import { cn } from "../../lib/cn";
import { IconButton } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { openExternal, revealInFinder } from "../../lib/platform";
import { runCommandSafely } from "../../lib/command";
import { formatFileSize } from "../../lib/format-size";
import { useFileViewerStore, selectFileViewerTab } from "../../store/file-viewer";
import CodeView from "./CodeView";
import ImageViewer from "./ImageViewer";

interface FileViewerPanelProps {
  tabId: string;
  isActive: boolean;
}

function joinPath(rootPath: string, filePath: string): string {
  return `${rootPath.replace(/\/$/, "")}/${filePath}`;
}

function toFileUrl(absolutePath: string): string {
  return `file://${absolutePath.split("/").map(encodeURIComponent).join("/")}`;
}

function isHtmlFile(name: string): boolean {
  return /\.(html?|xhtml)$/i.test(name);
}

function FileViewerPanel({ tabId }: FileViewerPanelProps) {
  const entry = useFileViewerStore(selectFileViewerTab(tabId));
  const reload = useFileViewerStore((s) => s.reload);
  const [wrap, setWrap] = useState(false);

  const handleReload = useCallback(() => {
    void reload(tabId);
  }, [reload, tabId]);

  const handleCopyPath = useCallback(() => {
    if (!entry || !navigator.clipboard) return;
    void navigator.clipboard.writeText(entry.path);
  }, [entry]);

  const handleReveal = useCallback(() => {
    if (!entry) return;
    void runCommandSafely(() => revealInFinder(joinPath(entry.rootPath, entry.path)), {
      errorToast: "Failed to reveal file in Finder",
    });
  }, [entry]);

  const handleOpenInBrowser = useCallback(() => {
    if (!entry) return;
    void runCommandSafely(() => openExternal(toFileUrl(joinPath(entry.rootPath, entry.path))), {
      errorToast: "Failed to open in browser",
    });
  }, [entry]);

  if (!entry) return null;

  const isText = entry.status === "loaded" && entry.data?.kind === "text";
  const loading = entry.status === "loading" || entry.status === "idle";

  return (
    <div className={cn("flex h-full flex-col bg-background")}>
      <div
        className={cn(
          "flex h-9 shrink-0 items-center gap-2 border-b border-border bg-sidebar px-3",
        )}
      >
        <span className={cn("shrink-0 truncate text-xs font-medium text-foreground")}>
          {entry.name}
        </span>
        <span
          className={cn("min-w-0 flex-1 truncate text-[11px] text-muted-foreground")}
          title={entry.path}
        >
          {entry.path}
        </span>
        {isHtmlFile(entry.name) && (
          <IconButton
            onClick={handleOpenInBrowser}
            title="Open in browser"
            aria-label="Open in browser"
          >
            <Globe className={cn("size-3")} />
          </IconButton>
        )}
        {isText && (
          <IconButton
            onClick={() => setWrap((value) => !value)}
            title="Toggle word wrap"
            aria-label="Toggle word wrap"
            aria-pressed={wrap}
            className={cn({ "bg-accent/10 text-foreground": wrap })}
          >
            <WrapText className={cn("size-3")} />
          </IconButton>
        )}
        <IconButton onClick={handleReload} disabled={loading} title="Reload" aria-label="Reload">
          <RotateCw className={cn("size-3", { "animate-spin": loading })} />
        </IconButton>
        <IconButton onClick={handleCopyPath} title="Copy path" aria-label="Copy path">
          <Copy className={cn("size-3")} />
        </IconButton>
        <IconButton onClick={handleReveal} title="Reveal in Finder" aria-label="Reveal in Finder">
          <FolderOpen className={cn("size-3")} />
        </IconButton>
      </div>

      <FileViewerBody entry={entry} wrap={wrap} onReload={handleReload} onReveal={handleReveal} />
    </div>
  );
}

interface FileViewerBodyProps {
  entry: NonNullable<ReturnType<ReturnType<typeof selectFileViewerTab>>>;
  wrap: boolean;
  onReload: () => void;
  onReveal: () => void;
}

function FileViewerBody({ entry, wrap, onReload, onReveal }: FileViewerBodyProps) {
  if (entry.status === "loading" || entry.status === "idle") {
    return (
      <div className={cn("flex min-h-0 flex-1 items-center justify-center")}>
        <Spinner className={cn("size-5 text-muted-foreground")} />
      </div>
    );
  }

  if (entry.status === "error" || !entry.data) {
    return (
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center",
        )}
      >
        <p className={cn("text-sm text-muted-foreground")}>
          {entry.error ?? "Failed to load file"}
        </p>
        <button
          type="button"
          onClick={onReload}
          className={cn(
            "rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground",
            "transition-colors hover:bg-secondary/50 hover:text-foreground",
          )}
        >
          Retry
        </button>
      </div>
    );
  }

  const { data } = entry;

  if (data.kind === "image") {
    return <ImageViewer data={data} name={entry.name} />;
  }

  if (data.kind === "text") {
    return <CodeView content={data.content} fileName={entry.name} size={data.size} wrap={wrap} />;
  }

  const message = data.kind === "tooLarge" ? "File is too large to preview" : "Binary file";

  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center",
      )}
    >
      <div
        className={cn(
          "flex size-12 items-center justify-center rounded-xl border border-border bg-secondary/30",
        )}
      >
        <File className={cn("size-5 text-muted-foreground")} />
      </div>
      <div>
        <p className={cn("text-sm font-medium text-foreground")}>{message}</p>
        <p className={cn("mt-1 text-xs text-muted-foreground")}>{formatFileSize(data.size)}</p>
      </div>
      <button
        type="button"
        onClick={onReveal}
        className={cn(
          "rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground",
          "transition-colors hover:bg-secondary/50 hover:text-foreground",
        )}
      >
        Reveal in Finder
      </button>
    </div>
  );
}

export default FileViewerPanel;
