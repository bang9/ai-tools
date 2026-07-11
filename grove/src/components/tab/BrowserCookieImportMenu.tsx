import { useCallback, useState } from "react";
import { Cookie, Loader2 } from "lucide-react";
import { cn } from "../../lib/cn";
import { IconButton } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { browserDetectBrowsers, browserImportCookies } from "../../lib/platform";
import type { DetectedBrowser } from "../../lib/platform";
import { useToast } from "../../store/toast";

interface BrowserCookieImportMenuProps {
  /** Current page URL, used to scope the import to the active site's host. */
  url: string | null;
  /** Called after a successful import so the caller can reload the page. */
  onImported: () => void;
}

function hostOf(url: string | null): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Toolbar menu that imports login cookies from an installed browser (Chrome,
 * Arc, Safari, …) into Grove's browser session, so the user is logged in
 * inside the embedded browser. Import is scoped to the current site's host when
 * one is loaded. Decryption happens in grove-core; this only drives the UI.
 */
export default function BrowserCookieImportMenu({ url, onImported }: BrowserCookieImportMenuProps) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [browsers, setBrowsers] = useState<DetectedBrowser[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (next) {
      setBrowsers(null);
      browserDetectBrowsers()
        .then((list) => setBrowsers(list.filter((b) => b.available)))
        .catch(() => setBrowsers([]));
    }
  }, []);

  const handleImport = useCallback(
    async (browser: DetectedBrowser) => {
      setBusy(browser.family);
      try {
        const count = await browserImportCookies(browser.family, hostOf(url));
        toast("success", `Imported ${count} cookie${count === 1 ? "" : "s"} from ${browser.label}`);
        setOpen(false);
        if (count > 0) onImported();
      } catch (error) {
        toast("error", error instanceof Error ? error.message : "Failed to import cookies");
      } finally {
        setBusy(null);
      }
    },
    [onImported, toast, url],
  );

  const renderList = () => {
    if (browsers === null) {
      return (
        <div className={cn("flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground")}>
          <Loader2 className={cn("size-3.5 animate-spin")} />
          <span>Detecting…</span>
        </div>
      );
    }
    if (browsers.length === 0) {
      return (
        <div className={cn("px-2 py-1.5 text-xs text-muted-foreground")}>No browsers found</div>
      );
    }
    return browsers.map((browser) => (
      <button
        key={browser.family}
        type="button"
        disabled={busy !== null}
        onClick={() => void handleImport(browser)}
        className={cn(
          "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors",
          "text-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-50",
        )}
      >
        {busy === browser.family ? (
          <Loader2 className={cn("size-3.5 animate-spin")} />
        ) : (
          <Cookie className={cn("size-3.5 text-muted-foreground")} />
        )}
        <span>{browser.label}</span>
      </button>
    ));
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <IconButton
          title="Import cookies from another browser"
          aria-label="Import cookies"
          className={cn("h-6 w-6")}
        >
          <Cookie className={cn("size-3.5")} />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="end" className={cn("w-auto min-w-[200px] p-1")}>
        <div className={cn("px-2 py-1 text-[11px] font-medium text-muted-foreground")}>
          Import cookies from
        </div>
        {renderList()}
      </PopoverContent>
    </Popover>
  );
}
