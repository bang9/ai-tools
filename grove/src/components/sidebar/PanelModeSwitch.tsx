import { cn } from "../../lib/cn";
import { usePanelLayoutStore } from "../../store/panel-layout";

interface Props {
  className?: string;
}

export function PanelModeSwitch({ className }: Props) {
  const sidebarMode = usePanelLayoutStore((s) => s.sidebarMode);
  const setSidebarMode = usePanelLayoutStore((s) => s.setSidebarMode);

  return (
    <div
      className={cn(
        "grid min-w-0 grid-cols-2 gap-0.5 rounded-lg border border-border/70 bg-[var(--color-bg-tertiary)]/70 p-0.5",
        className,
      )}
    >
      <button
        className={cn(
          "flex h-7 cursor-pointer items-center justify-center rounded-md px-2.5 text-[10px] font-semibold uppercase tracking-[0.06em] transition-all duration-150",
          {
            "bg-sidebar text-[var(--color-text-primary)] shadow-sm": sidebarMode === "projects",
            "text-[var(--color-text-muted)] hover:bg-[var(--color-bg-secondary)]/60 hover:text-[var(--color-text-secondary)]":
              sidebarMode !== "projects",
          },
        )}
        onClick={() => setSidebarMode("projects")}
        aria-pressed={sidebarMode === "projects"}
      >
        Projects
      </button>
      <button
        className={cn(
          "flex h-7 cursor-pointer items-center justify-center rounded-md px-2.5 text-[10px] font-semibold uppercase tracking-[0.06em] transition-all duration-150",
          {
            "bg-sidebar text-[var(--color-text-primary)] shadow-sm": sidebarMode === "missions",
            "text-[var(--color-text-muted)] hover:bg-[var(--color-bg-secondary)]/60 hover:text-[var(--color-text-secondary)]":
              sidebarMode !== "missions",
          },
        )}
        onClick={() => setSidebarMode("missions")}
        aria-pressed={sidebarMode === "missions"}
      >
        Missions
      </button>
    </div>
  );
}
