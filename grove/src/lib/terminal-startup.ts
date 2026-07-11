import type { TerminalInitialContentSource, TerminalPaneSeed } from "./terminal-runtime";
import type { TerminalRestorePlanEntry } from "./terminal-session";
import type { CreatePtyInitialHydration, CreatePtyResult } from "./platform";

// The hydration sources the renderer knows how to replay. Anything else (a
// future backend source) degrades to "no replay" rather than a mis-typed seed.
function mapHydrationSource(
  source: CreatePtyInitialHydration["source"] | undefined,
): TerminalInitialContentSource | undefined {
  if (source === "tmuxCapture" || source === "daemonSnapshot") {
    return source;
  }
  return undefined;
}

// Nullable numeric/string/bool wire fields (grove-core serializes absent Options
// as omitted; the Electron JSON bridge can surface them as null) collapse to
// undefined so the seed carries only real values.
function optionalNumber(value: number | null | undefined): number | undefined {
  return typeof value === "number" ? value : undefined;
}
function optionalString(value: string | null | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function optionalBoolean(value: boolean | null | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

// Thread the daemon-snapshot reattach metadata onto the seed. Every field is
// undefined for a tmux capture (grove-core leaves them None), so this is inert
// for that path.
function daemonSnapshotSeedFields(
  hydration: CreatePtyInitialHydration | null | undefined,
): Pick<
  TerminalPaneSeed,
  | "snapshotCols"
  | "snapshotRows"
  | "isAlternateScreen"
  | "pendingEscapeTailAnsi"
  | "kittyKeyboardFlags"
  | "isColdRestore"
> {
  return {
    snapshotCols: optionalNumber(hydration?.snapshotCols),
    snapshotRows: optionalNumber(hydration?.snapshotRows),
    isAlternateScreen: optionalBoolean(hydration?.isAlternateScreen),
    pendingEscapeTailAnsi: optionalString(hydration?.pendingEscapeTailAnsi),
    kittyKeyboardFlags: optionalNumber(hydration?.kittyKeyboardFlags),
    isColdRestore: optionalBoolean(hydration?.isColdRestore),
  };
}

export function buildTerminalPaneSeed(
  pane: Pick<TerminalRestorePlanEntry, "launchCwd" | "scrollback">,
  ptyId: string,
  createResult: CreatePtyResult,
): TerminalPaneSeed {
  if (createResult.sessionState === "attached") {
    const hydration = createResult.initialHydration;
    return {
      ptyId,
      launchCwd: pane.launchCwd,
      initialScrollback: hydration?.text,
      initialScrollbackSource: mapHydrationSource(hydration?.source),
      ...daemonSnapshotSeedFields(hydration),
    };
  }

  return {
    ptyId,
    launchCwd: pane.launchCwd,
    initialScrollback: pane.scrollback || undefined,
    initialScrollbackSource: pane.scrollback ? "snapshotFallback" : undefined,
  };
}
