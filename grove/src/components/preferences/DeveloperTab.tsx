import { useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { cn } from "../../lib/cn";
import { TERMINAL_GC_INTERVAL_MS, runTerminalGcNow } from "../../lib/terminal-gc";
import {
  getCommandErrorMessage,
  openDevConsole,
  reloadAppWindow,
  type TerminalGcReport,
} from "../../lib/platform";
import { useToastStore } from "../../store/toast";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Separator } from "../ui/separator";

type RunMode = "dry-run" | "apply";
type WindowAction = "dev-console" | "reload";

interface RunSummary {
  mode: RunMode;
  report: TerminalGcReport;
  completedAt: string;
}

type ReportTone = "secondary" | "warning" | "danger" | "success";

interface ReportEntry {
  id: string;
  kind: string;
  value: string;
  tone: ReportTone;
}

function formatRunMode(mode: RunMode): string {
  return mode === "dry-run" ? "Dry Run" : "Run Now";
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function countDryRunFindings(report: TerminalGcReport): number {
  return Math.max(report.staleWorktreePaths.length, report.staleSessionNames.length);
}

function countAppliedChanges(report: TerminalGcReport): number {
  return Math.max(report.prunedWorktreePaths.length, report.killedSessionNames.length);
}

function buildReportEntries(report: TerminalGcReport): ReportEntry[] {
  return [
    ...report.staleWorktreePaths.map((value) => ({
      id: `stale-path:${value}`,
      kind: "stale path",
      value,
      tone: "warning" as const,
    })),
    ...report.staleSessionNames.map((value) => ({
      id: `stale-session:${value}`,
      kind: "stale session",
      value,
      tone: "warning" as const,
    })),
    ...report.prunedWorktreePaths.map((value) => ({
      id: `pruned-path:${value}`,
      kind: "pruned path",
      value,
      tone: "success" as const,
    })),
    ...report.killedSessionNames.map((value) => ({
      id: `killed-session:${value}`,
      kind: "killed session",
      value,
      tone: "success" as const,
    })),
    ...report.skippedAttachedWorktreePaths.map((value) => ({
      id: `skipped-attached:${value}`,
      kind: "skipped attached",
      value,
      tone: "secondary" as const,
    })),
    ...report.leftoverProcessIds.map((value) => ({
      id: `leftover-pid:${value}`,
      kind: "leftover pid",
      value: String(value),
      tone: "danger" as const,
    })),
  ];
}

function buildReportHeadline(summary: RunSummary): {
  title: string;
  tone: ReportTone;
  detail: string;
} {
  if (summary.mode === "dry-run") {
    const findings = countDryRunFindings(summary.report);
    if (findings > 0) {
      return {
        title: "Potential stale terminal state detected",
        tone: "warning",
        detail: `${pluralize(findings, "stale item")} would be reconciled by an apply run.`,
      };
    }

    return {
      title: "No stale terminal state found",
      tone: "success",
      detail: "No missing-path tmux sessions or stale layout references were found.",
    };
  }

  const changes = countAppliedChanges(summary.report);
  if (changes > 0) {
    return {
      title: "Terminal GC applied cleanup",
      tone: "success",
      detail: `${pluralize(changes, "stale item")} were reconciled during the last run.`,
    };
  }

  return {
    title: "Terminal GC found nothing to clean",
    tone: "secondary",
    detail: "The last apply run completed without changes.",
  };
}

function toneToBadgeVariant(tone: ReportTone): "secondary" | "warning" | "danger" | "success" {
  return tone === "danger" ? "danger" : tone;
}

function statItems(report: TerminalGcReport) {
  return [
    { label: "stale", value: countDryRunFindings(report) },
    { label: "killed", value: report.killedSessionNames.length },
    { label: "pruned", value: report.prunedWorktreePaths.length },
    { label: "skipped attached", value: report.skippedAttachedWorktreePaths.length },
    { label: "leftover", value: report.leftoverProcessIds.length },
  ];
}

function formatCompletedAt(iso: string): string {
  return new Date(iso).toLocaleString([], {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function ReportStatus({ summary }: { summary: RunSummary }) {
  const headline = buildReportHeadline(summary);
  const statusBadgeLabel = (() => {
    if (headline.tone === "warning") {
      return "Findings";
    }
    if (headline.tone === "success") {
      return "Cleaned";
    }
    return "No Changes";
  })();

  return (
    <div className={cn("rounded-md border border-border bg-secondary/15 p-4")}>
      <div className={cn("flex flex-wrap items-start justify-between gap-3")}>
        <div className={cn("min-w-0")}>
          <div className={cn("flex flex-wrap items-center gap-2")}>
            <h5 className={cn("text-[12px] font-medium text-foreground")}>Last Report</h5>
            <Badge variant="outline">{formatRunMode(summary.mode)}</Badge>
            <Badge variant={toneToBadgeVariant(headline.tone)}>{statusBadgeLabel}</Badge>
          </div>
          <p className={cn("mt-2 text-[13px] text-foreground")}>{headline.title}</p>
          <p className={cn("mt-1 text-[11px] text-muted-foreground/80")}>{headline.detail}</p>
        </div>

        <div className={cn("text-[11px] text-muted-foreground tabular-nums")}>
          {formatCompletedAt(summary.completedAt)}
        </div>
      </div>

      <div className={cn("mt-4 flex flex-wrap gap-2")}>
        {statItems(summary.report).map((item) => (
          <div
            key={item.label}
            className={cn("rounded-md border border-border bg-background px-2.5 py-1.5")}
          >
            <span className={cn("text-[10px] uppercase tracking-wider text-muted-foreground")}>
              {item.label}
            </span>
            <span className={cn("ml-2 text-[12px] font-medium text-foreground tabular-nums")}>
              {item.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReportLog({
  summary,
  open,
  onToggle,
}: {
  summary: RunSummary;
  open: boolean;
  onToggle: () => void;
}) {
  const entries = buildReportEntries(summary.report);

  return (
    <div className={cn("mt-5")}>
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "flex items-center gap-1 text-[11px] font-medium text-muted-foreground uppercase tracking-wider transition-colors hover:text-foreground",
        )}
      >
        {open ? (
          <ChevronDown size={12} strokeWidth={2} />
        ) : (
          <ChevronRight size={12} strokeWidth={2} />
        )}
        Report Log
      </button>

      {open ? (
        <div className={cn("mt-3 overflow-hidden rounded-md border border-border bg-background")}>
          <div className={cn("border-b border-border bg-secondary/20 px-3 py-2")}>
            <p className={cn("text-[11px] text-muted-foreground")}>
              {entries.length > 0
                ? `${entries.length} log entries from the last ${formatRunMode(summary.mode).toLowerCase()} run`
                : "No log entries from the last run"}
            </p>
          </div>

          <div className={cn("max-h-[320px] overflow-y-auto")}>
            {entries.length === 0 ? (
              <div className={cn("px-3 py-3 font-mono text-[12px] text-muted-foreground")}>
                [{formatRunMode(summary.mode).toLowerCase()}] no stale terminal sessions found
              </div>
            ) : (
              entries.map((entry, index) => (
                <div
                  key={entry.id}
                  className={cn(
                    "grid grid-cols-[auto_auto_1fr] items-start gap-3 px-3 py-2 font-mono text-[12px]",
                    { "border-t border-border/80": index > 0 },
                  )}
                >
                  <span className={cn("tabular-nums text-muted-foreground/80")}>
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <Badge
                    variant={toneToBadgeVariant(entry.tone)}
                    className={cn(
                      "mt-0.5 rounded-sm px-1.5 py-0 text-[10px] uppercase tracking-wider",
                    )}
                  >
                    {entry.kind}
                  </Badge>
                  <code className={cn("break-all text-foreground")}>{entry.value}</code>
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function DeveloperTab() {
  const addToast = useToastStore((s) => s.addToast);
  const [runningMode, setRunningMode] = useState<RunMode | null>(null);
  const [runningWindowAction, setRunningWindowAction] = useState<WindowAction | null>(null);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [reportOpen, setReportOpen] = useState(true);
  const intervalMinutes = Math.round(TERMINAL_GC_INTERVAL_MS / 60_000);

  const handleWindowAction = async (action: WindowAction) => {
    setRunningWindowAction(action);

    try {
      if (action === "dev-console") {
        await openDevConsole();
      } else {
        await reloadAppWindow();
      }
    } catch (error) {
      addToast(
        "error",
        action === "dev-console"
          ? `Failed to open dev console: ${getCommandErrorMessage(error)}`
          : `Failed to reload window: ${getCommandErrorMessage(error)}`,
      );
    } finally {
      setRunningWindowAction(null);
    }
  };

  const handleRun = async (mode: RunMode) => {
    setRunningMode(mode);
    const dryRun = mode === "dry-run";
    const nextReport = await runTerminalGcNow(dryRun, {
      errorToast: dryRun ? "Failed to run terminal GC dry run" : "Failed to run terminal GC",
    });
    setRunningMode(null);

    if (!nextReport) {
      return;
    }

    setSummary({
      mode,
      report: nextReport,
      completedAt: new Date().toISOString(),
    });
    setReportOpen(true);

    if (dryRun) {
      const findingCount = countDryRunFindings(nextReport);
      addToast(
        findingCount > 0 ? "info" : "success",
        findingCount > 0
          ? `Terminal GC dry run found ${pluralize(findingCount, "stale item")}`
          : "No stale terminal sessions found",
      );
      return;
    }

    const reconciledCount = countAppliedChanges(nextReport);
    addToast(
      reconciledCount > 0 ? "success" : "info",
      reconciledCount > 0
        ? `Terminal GC reconciled ${pluralize(reconciledCount, "stale item")}`
        : "No stale terminal sessions found",
    );
  };

  return (
    <div>
      <h3 className={cn("text-sm font-semibold text-foreground mb-6")}>Developer</h3>

      <section>
        <h4 className={cn("text-[12px] font-medium text-foreground mb-1.5")}>Window Controls</h4>
        <p className={cn("text-[11px] text-muted-foreground/70 mb-4")}>
          Open the current renderer dev console or reload the current Grove window without leaving
          the app.
        </p>

        <div className={cn("flex items-center gap-2")}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={runningWindowAction !== null}
            onClick={() => void handleWindowAction("dev-console")}
          >
            {runningWindowAction === "dev-console" ? (
              <Loader2 className={cn("animate-spin")} />
            ) : null}
            Open Dev Console
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={runningWindowAction !== null}
            onClick={() => void handleWindowAction("reload")}
          >
            {runningWindowAction === "reload" ? <Loader2 className={cn("animate-spin")} /> : null}
            Reload
          </Button>
          {runningWindowAction ? (
            <span className={cn("text-[11px] text-muted-foreground")}>
              {runningWindowAction === "dev-console"
                ? "Opening dev console..."
                : "Reloading window..."}
            </span>
          ) : null}
        </div>
      </section>

      <Separator className={cn("my-6")} />

      <section>
        <h4 className={cn("text-[12px] font-medium text-foreground mb-1.5")}>
          Terminal Garbage Collection
        </h4>
        <p className={cn("text-[11px] text-muted-foreground/70 mb-4")}>
          Reconcile stale terminal layouts and tmux sessions whose mission or worktree path no
          longer exists.
        </p>

        <div className={cn("rounded-md border border-border bg-secondary/20 px-3 py-2 mb-4")}>
          <p className={cn("text-[11px] text-muted-foreground")}>
            Auto GC runs every {intervalMinutes} minutes
          </p>
          <p className={cn("text-[11px] text-muted-foreground/70 mt-1")}>
            Attached sessions are skipped automatically. Process cleanup only runs as a fallback
            after tmux session cleanup.
          </p>
        </div>

        <div className={cn("flex items-center gap-2 mb-5")}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={runningMode !== null}
            onClick={() => void handleRun("dry-run")}
          >
            {runningMode === "dry-run" ? <Loader2 className={cn("animate-spin")} /> : null}
            Dry Run
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={runningMode !== null}
            onClick={() => void handleRun("apply")}
          >
            {runningMode === "apply" ? <Loader2 className={cn("animate-spin")} /> : null}
            Run Now
          </Button>
          {runningMode ? (
            <span className={cn("text-[11px] text-muted-foreground")}>
              Running {formatRunMode(runningMode).toLowerCase()}...
            </span>
          ) : null}
        </div>

        {summary ? (
          <>
            <ReportStatus summary={summary} />
            <ReportLog
              summary={summary}
              open={reportOpen}
              onToggle={() => setReportOpen((open) => !open)}
            />
          </>
        ) : (
          <div
            className={cn("rounded-md border border-dashed border-border bg-background px-3 py-4")}
          >
            <p className={cn("text-[12px] text-foreground")}>No report yet</p>
            <p className={cn("mt-1 text-[11px] text-muted-foreground/70")}>
              Run a dry run or apply GC to generate a report.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
