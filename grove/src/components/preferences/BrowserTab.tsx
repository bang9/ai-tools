import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "../../lib/cn";
import { browserDetectBrowsers, browserImportCookies } from "../../lib/platform";
import type { DetectedBrowser } from "../../lib/platform";
import { useToastStore } from "../../store/toast";
import { Button } from "../ui/button";

export default function BrowserTab() {
  const addToast = useToastStore((s) => s.addToast);
  const [browsers, setBrowsers] = useState<DetectedBrowser[] | null>(null);
  const [importing, setImporting] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    browserDetectBrowsers()
      .then((list) => {
        if (!cancelled) setBrowsers(list.filter((b) => b.available));
      })
      .catch(() => {
        if (!cancelled) setBrowsers([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleImport = useCallback(
    async (browser: DetectedBrowser) => {
      setImporting(browser.family);
      try {
        // Settings-level import brings over the browser's whole cookie jar (no
        // per-site scoping), so the user is signed in across sites in Grove.
        const count = await browserImportCookies(browser.family);
        addToast(
          "success",
          `Imported ${count} cookie${count === 1 ? "" : "s"} from ${browser.label}`,
        );
      } catch (error) {
        addToast("error", error instanceof Error ? error.message : "Failed to import cookies");
      } finally {
        setImporting(null);
      }
    },
    [addToast],
  );

  const renderBrowsers = () => {
    if (browsers === null) {
      return (
        <div className={cn("flex items-center gap-2 text-[12px] text-muted-foreground")}>
          <Loader2 className={cn("size-3.5 animate-spin")} />
          <span>Detecting installed browsers…</span>
        </div>
      );
    }
    if (browsers.length === 0) {
      return (
        <div
          className={cn("rounded-md border border-dashed border-border bg-background px-3 py-4")}
        >
          <p className={cn("text-[12px] text-foreground")}>No importable browsers found</p>
          <p className={cn("mt-1 text-[11px] text-muted-foreground/70")}>
            Grove looks for Chrome, Arc, Brave, Edge, Chromium, Safari, and Firefox.
          </p>
        </div>
      );
    }
    return (
      <div className={cn("flex flex-col gap-2")}>
        {browsers.map((browser) => (
          <div
            key={browser.family}
            className={cn(
              "flex items-center justify-between gap-3 rounded-md border border-border bg-secondary/15 px-3 py-2",
            )}
          >
            <span className={cn("text-[13px] text-foreground")}>{browser.label}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={importing !== null}
              onClick={() => void handleImport(browser)}
            >
              {importing === browser.family ? <Loader2 className={cn("animate-spin")} /> : null}
              Import Cookies
            </Button>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div>
      <h3 className={cn("text-sm font-semibold text-foreground mb-6")}>Browser</h3>

      <section>
        <h4 className={cn("text-[12px] font-medium text-foreground mb-1.5")}>Import Cookies</h4>
        <p className={cn("text-[11px] text-muted-foreground/70 mb-4")}>
          Copy login cookies from an installed browser into Grove&apos;s browser so you stay signed
          in on sites you open here. macOS may prompt for Keychain access. Safari requires Full Disk
          Access for Grove in System Settings.
        </p>
        {renderBrowsers()}
      </section>
    </div>
  );
}
