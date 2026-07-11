import { useState, useCallback, useEffect } from "react";
import { ChevronDown, ChevronRight, RotateCcw } from "lucide-react";
import { terminalThemes, themeDisplayNames, DEFAULT_THEME_KEY } from "../../lib/terminal-themes";
import { useTerminalStore } from "../../store/terminal";
import { saveAppConfig, getAppConfig } from "../../lib/platform";
import { runCommandSafely } from "../../lib/command";
import { Button } from "../ui/button";
import { cn } from "../../lib/cn";
import type { TerminalTheme } from "../../types";

const ANSI_LABELS: { key: keyof TerminalTheme; label: string }[] = [
  { key: "black", label: "Black" },
  { key: "red", label: "Red" },
  { key: "green", label: "Green" },
  { key: "yellow", label: "Yellow" },
  { key: "blue", label: "Blue" },
  { key: "magenta", label: "Magenta" },
  { key: "cyan", label: "Cyan" },
  { key: "white", label: "White" },
  { key: "brightBlack", label: "Bright Black" },
  { key: "brightRed", label: "Bright Red" },
  { key: "brightGreen", label: "Bright Green" },
  { key: "brightYellow", label: "Bright Yellow" },
  { key: "brightBlue", label: "Bright Blue" },
  { key: "brightMagenta", label: "Bright Magenta" },
  { key: "brightCyan", label: "Bright Cyan" },
  { key: "brightWhite", label: "Bright White" },
];

export default function TerminalAppearance() {
  const theme = useTerminalStore((s) => s.theme);
  const detectedTheme = useTerminalStore((s) => s.detectedTheme);
  const loadTheme = useTerminalStore((s) => s.loadTheme);

  const [draft, setDraft] = useState<TerminalTheme | null>(null);
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [colorsOpen, setColorsOpen] = useState(false);

  useEffect(() => {
    if (theme) {
      setDraft({ ...theme });
      const allPresets: [string, TerminalTheme][] = [
        ...Object.entries(terminalThemes),
        ...(detectedTheme ? [["system", detectedTheme] as [string, TerminalTheme]] : []),
      ];
      const match = allPresets.find(
        ([, preset]) =>
          preset.background === theme.background && preset.foreground === theme.foreground,
      );
      setActivePreset(match ? match[0] : null);
    }
  }, [theme, detectedTheme]);

  const updateDraft = useCallback((key: keyof TerminalTheme, value: string | number) => {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
    setActivePreset(null);
  }, []);

  const selectPreset = useCallback(
    (key: string) => {
      const preset = key === "system" ? detectedTheme : terminalThemes[key];
      if (!preset) return;
      setDraft((prev) => ({
        ...preset,
        fontFamily: prev?.fontFamily ?? preset.fontFamily,
        fontSize: prev?.fontSize ?? preset.fontSize,
      }));
      setActivePreset(key);
    },
    [detectedTheme],
  );

  const handleApply = useCallback(async () => {
    if (!draft) return;
    loadTheme(draft);
    await runCommandSafely(
      async () => {
        const config = await getAppConfig();
        await saveAppConfig({ ...config, terminalTheme: draft });
      },
      {
        errorToast: "Failed to save terminal theme",
      },
    );
  }, [draft, loadTheme]);

  const handleReset = useCallback(() => {
    if (detectedTheme) {
      setDraft({ ...detectedTheme });
      setActivePreset("system");
    } else {
      setDraft({ ...terminalThemes[DEFAULT_THEME_KEY] });
      setActivePreset(DEFAULT_THEME_KEY);
    }
  }, [detectedTheme]);

  if (!draft) return null;

  return (
    <div>
      <h4 className={cn("text-[12px] font-medium text-foreground mb-4")}>Appearance</h4>

      <div className={cn("flex flex-col gap-5")}>
        {/* Preset Themes */}
        <section>
          <h5
            className={cn(
              "text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-2",
            )}
          >
            Presets
          </h5>
          <div className={cn("grid grid-cols-3 gap-1.5")}>
            {[
              ...(detectedTheme ? [["system", "System"] as const] : []),
              ...Object.entries(themeDisplayNames),
            ].map(([key, name]) => {
              const preset = key === "system" ? detectedTheme : terminalThemes[key];
              if (!preset) return null;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => selectPreset(key)}
                  className={cn(
                    "flex items-center gap-2 px-2.5 py-2 rounded-[var(--radius-md)] border text-left transition-colors",
                    {
                      "border-[var(--color-primary)] bg-[var(--color-primary-light)]":
                        activePreset === key,
                      "border-[var(--color-border)] hover:border-[var(--color-primary-border)] hover:bg-[var(--color-bg-secondary)]":
                        activePreset !== key,
                    },
                  )}
                >
                  <div
                    className={cn(
                      "w-5 h-5 rounded-[3px] border border-[var(--color-border)] shrink-0",
                    )}
                    style={{ backgroundColor: preset.background }}
                  >
                    <span
                      className={cn("block text-[8px] leading-[20px] text-center font-bold")}
                      style={{ color: preset.foreground }}
                    >
                      A
                    </span>
                  </div>
                  <span className={cn("text-[12px] text-[var(--color-text)] truncate")}>
                    {name}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        {/* Font Settings */}
        <section>
          <h5
            className={cn(
              "text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-2",
            )}
          >
            Font
          </h5>
          <div className={cn("flex flex-col gap-2.5")}>
            <div>
              <label className={cn("block text-[11px] text-muted-foreground mb-1")}>
                Font Family
              </label>
              <input
                type="text"
                value={draft.fontFamily}
                onChange={(e) => updateDraft("fontFamily", e.target.value)}
                className={cn(
                  "w-full max-w-[280px] px-2.5 py-1.5 text-[12px] rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] focus:outline-none focus:border-[var(--color-primary)] transition-colors",
                )}
              />
            </div>
            <div>
              <div className={cn("flex items-center justify-between mb-1 max-w-[280px]")}>
                <label className={cn("text-[11px] text-muted-foreground")}>Font Size</label>
                <span className={cn("text-[11px] text-[var(--color-text-tertiary)] tabular-nums")}>
                  {draft.fontSize}px
                </span>
              </div>
              <input
                type="range"
                min={10}
                max={20}
                step={1}
                value={draft.fontSize}
                onChange={(e) => updateDraft("fontSize", Number(e.target.value))}
                className={cn(
                  "w-full max-w-[280px] h-1 accent-[var(--color-primary)] cursor-pointer",
                )}
              />
            </div>
          </div>
        </section>

        {/* Core Colors */}
        <section>
          <h5
            className={cn(
              "text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-2",
            )}
          >
            Colors
          </h5>
          <div className={cn("flex flex-col gap-2")}>
            <ColorRow
              label="Background"
              value={draft.background}
              onChange={(v) => updateDraft("background", v)}
            />
            <ColorRow
              label="Foreground"
              value={draft.foreground}
              onChange={(v) => updateDraft("foreground", v)}
            />
            <ColorRow
              label="Cursor"
              value={draft.cursor}
              onChange={(v) => updateDraft("cursor", v)}
            />
          </div>
        </section>

        {/* ANSI Colors (collapsible) */}
        <section>
          <button
            type="button"
            onClick={() => setColorsOpen((v) => !v)}
            className={cn(
              "flex items-center gap-1 text-[11px] font-medium text-muted-foreground uppercase tracking-wider hover:text-[var(--color-text-secondary)] transition-colors mb-2",
            )}
          >
            {colorsOpen ? (
              <ChevronDown size={12} strokeWidth={2} />
            ) : (
              <ChevronRight size={12} strokeWidth={2} />
            )}
            ANSI Colors
          </button>
          {colorsOpen && (
            <div className={cn("flex flex-col gap-2")}>
              {ANSI_LABELS.map(({ key, label }) => (
                <ColorRow
                  key={key}
                  label={label}
                  value={draft[key] as string}
                  onChange={(v) => updateDraft(key, v)}
                />
              ))}
            </div>
          )}
        </section>

        {/* Preview */}
        <section>
          <h5
            className={cn(
              "text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-2",
            )}
          >
            Preview
          </h5>
          <div
            className={cn(
              "rounded-[var(--radius-md)] border border-[var(--color-border)] p-3 text-[12px] leading-[1.6] overflow-hidden",
            )}
            style={{
              backgroundColor: draft.background,
              color: draft.foreground,
              fontFamily: draft.fontFamily,
              fontSize: `${draft.fontSize}px`,
            }}
          >
            <div>
              <span style={{ color: draft.green }}>user</span>
              <span style={{ color: draft.foreground }}>@</span>
              <span style={{ color: draft.blue }}>grove</span>
              <span style={{ color: draft.foreground }}> ~ $ </span>
              <span style={{ color: draft.foreground }}>echo </span>
              <span style={{ color: draft.yellow }}>&quot;Hello, World!&quot;</span>
            </div>
            <div style={{ color: draft.foreground }}>Hello, World!</div>
            <div>
              <span style={{ color: draft.red }}>error:</span>
              <span style={{ color: draft.foreground }}> something went wrong</span>
            </div>
            <div>
              <span style={{ color: draft.cyan }}>info:</span>
              <span style={{ color: draft.foreground }}> task completed</span>
            </div>
          </div>
        </section>

        {/* Actions */}
        <div className={cn("flex items-center gap-2")}>
          <Button variant="ghost" size="sm" onClick={handleReset}>
            <RotateCcw size={12} strokeWidth={1.5} />
            Reset
          </Button>
          <Button size="sm" onClick={handleApply}>
            Apply
          </Button>
        </div>
      </div>
    </div>
  );
}

function ColorRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-2 max-w-[280px]")}>
      <span className={cn("text-[11px] text-muted-foreground")}>{label}</span>
      <div className={cn("flex items-center gap-1.5")}>
        <span
          className={cn(
            "text-[10px] text-[var(--color-text-tertiary)] font-mono tabular-nums uppercase",
          )}
        >
          {value}
        </span>
        <label
          className={cn(
            "relative w-5 h-5 rounded-[3px] border border-[var(--color-border)] cursor-pointer overflow-hidden shrink-0",
          )}
        >
          <div className={cn("absolute inset-0")} style={{ backgroundColor: value }} />
          <input
            type="color"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className={cn("absolute inset-0 w-full h-full opacity-0 cursor-pointer")}
          />
        </label>
      </div>
    </div>
  );
}
