import { usePreferencesStore } from "../../store/preferences";
import { cn } from "../../lib/cn";
import type { TerminalLinkOpenMode } from "../../types";
import TerminalAppearance from "./TerminalAppearance";

const LINK_OPEN_OPTIONS: {
  value: TerminalLinkOpenMode;
  label: string;
  description: string;
}[] = [
  {
    value: "external",
    label: "External Browser",
    description: "Open all links in an external browser",
  },
  {
    value: "internal",
    label: "Grove Browser",
    description: "Open all links in Grove's built-in browser",
  },
  {
    value: "external-with-localhost-internal",
    label: "Localhost in Grove, others External",
    description: "Open localhost links in Grove, everything else externally",
  },
];

export default function TerminalTab() {
  const terminalLinkOpenMode = usePreferencesStore((s) => s.terminalLinkOpenMode);
  const setTerminalLinkOpenMode = usePreferencesStore((s) => s.setTerminalLinkOpenMode);

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setTerminalLinkOpenMode(e.target.value as TerminalLinkOpenMode);
  };

  return (
    <div>
      <h3 className={cn("text-sm font-semibold text-foreground mb-6")}>Terminal</h3>

      {/* Link Open Mode */}
      <div className={cn("mb-6")}>
        <h4 className={cn("text-[12px] font-medium text-foreground mb-1.5")}>Link Open Mode</h4>
        <p className={cn("text-[11px] text-muted-foreground/70 mb-2")}>
          Where links open when clicked in the terminal
        </p>
        <select
          value={terminalLinkOpenMode}
          onChange={handleChange}
          className={cn(
            "w-[320px] rounded-md border border-border bg-background px-3 py-1.5 text-[12px] text-foreground",
            "focus:outline-none focus:border-ring transition-colors",
          )}
        >
          {LINK_OPEN_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label} — {opt.description}
            </option>
          ))}
        </select>
      </div>

      {/* Divider */}
      <div className={cn("border-t border-border mb-6")} />

      {/* Appearance */}
      <TerminalAppearance />
    </div>
  );
}
