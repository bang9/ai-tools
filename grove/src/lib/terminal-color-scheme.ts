// DECSET 2031 color-scheme change notification (Contour/Kitty "color-scheme
// update" protocol). A 2031-subscribed TUI (fish, neovim, Claude Code) asks the
// terminal to push a status report whenever the host color scheme flips so it
// can repaint its palette. Grove drives this from its own theme toggle: without
// it, a light/dark switch leaves subscribed TUIs rendering the stale palette.
//
// This module is pure — the classifier, the byte sequence, and the two runtime
// decision functions — so the wiring in terminal-runtime.ts stays thin and the
// state-machine edges are unit-testable without a live xterm parser.

export type TerminalColorSchemeMode = "dark" | "light";

// Terminals push `CSI ?997;1n` for dark and `CSI ?997;2n` for light to a
// 2031-subscribed TUI. Byte-identical to the reply family Contour/Kitty use.
export function mode2031SequenceFor(mode: TerminalColorSchemeMode): string {
  return mode === "dark" ? "\x1b[?997;1n" : "\x1b[?997;2n";
}

/**
 * Relative luminance (Rec. 709 coefficients over normalized sRGB channels) of a
 * hex color, or null when the string is not a `#?RGB` / `#?RRGGBB` hex color.
 * Deliberately ungamma'd so a mid-gray (`#808080`) lands right at the 0.5
 * classification boundary — the palette flip must key on the same brightness a
 * human reads, not WCAG's perceptual curve which pins mid-gray near 0.2.
 */
export function relativeLuminanceFromHex(hex: string | null | undefined): number | null {
  if (typeof hex !== "string") {
    return null;
  }
  const raw = hex.trim().replace(/^#/, "");
  let r: number;
  let g: number;
  let b: number;
  if (raw.length === 3) {
    if (!/^[0-9a-fA-F]{3}$/.test(raw)) {
      return null;
    }
    r = parseInt(raw[0] + raw[0], 16);
    g = parseInt(raw[1] + raw[1], 16);
    b = parseInt(raw[2] + raw[2], 16);
  } else if (raw.length === 6) {
    if (!/^[0-9a-fA-F]{6}$/.test(raw)) {
      return null;
    }
    r = parseInt(raw.slice(0, 2), 16);
    g = parseInt(raw.slice(2, 4), 16);
    b = parseInt(raw.slice(4, 6), 16);
  } else {
    return null;
  }
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * Classify a terminal background into a color-scheme mode. Luminance `< 0.5` is
 * dark, `>= 0.5` is light; a malformed/absent hex defaults to dark so a
 * subscribed TUI never gets flipped to a light palette on bad input.
 */
export function colorSchemeModeForBackground(
  background: string | null | undefined,
): TerminalColorSchemeMode {
  const luminance = relativeLuminanceFromHex(background);
  if (luminance === null) {
    return "dark";
  }
  return luminance < 0.5 ? "dark" : "light";
}

// Per-runtime 2031 state: whether a live TUI is subscribed, and the last mode we
// actually pushed (so a same-mode theme re-apply pushes nothing).
export interface Mode2031SubscriptionState {
  subscribed: boolean;
  lastPushedMode: TerminalColorSchemeMode | null;
}

export const INITIAL_MODE_2031_STATE: Mode2031SubscriptionState = {
  subscribed: false,
  lastPushedMode: null,
};

export interface Mode2031Decision {
  state: Mode2031SubscriptionState;
  // Bytes to writeInput to the pty, or null to emit nothing.
  emit: string | null;
}

// A DECSET private-mode CSI carries its params either as flat numbers or, for
// subparams, nested arrays; 2031 is a subscribe iff it appears anywhere.
export function csiParamsIncludeMode2031(params: (number | number[])[]): boolean {
  return params.some((param) => (Array.isArray(param) ? param.includes(2031) : param === 2031));
}

/**
 * Decide the effect of a `CSI ? … {h|l}` that carries param 2031.
 *
 * - `set=false` (DECRST `?2031l`): unsubscribe — stop pushing and forget the
 *   last mode so a later re-subscribe seeds fresh.
 * - `set=true` (DECSET `?2031h`) while `replaying`: REPLAY GUARD. A `?2031h`
 *   replayed from restored scrollback must neither record the subscribe bit nor
 *   emit — a live TUI re-emits after startup, and echoing during replay is
 *   orca's "random characters on restart" bug.
 * - `set=true` live (not replaying): a real subscribe — record the bit and seed
 *   the
 *   current mode reply once.
 */
export function decideMode2031Csi(
  prev: Mode2031SubscriptionState,
  event: { set: boolean; replaying: boolean; currentMode: TerminalColorSchemeMode },
): Mode2031Decision {
  if (!event.set) {
    return { state: INITIAL_MODE_2031_STATE, emit: null };
  }
  if (event.replaying) {
    return { state: prev, emit: null };
  }
  return {
    state: { subscribed: true, lastPushedMode: event.currentMode },
    emit: mode2031SequenceFor(event.currentMode),
  };
}

/**
 * Decide whether a theme change should push a fresh 2031 report. Pushes only
 * when a live TUI is subscribed, the runtime is hydrated and has a pty, and the
 * derived mode actually changed from the last pushed value — the mode-change
 * check plus the caller's value-gated theme write are the near-threshold
 * flapping guard.
 */
export function decideColorSchemeThemePush(
  prev: Mode2031SubscriptionState,
  input: {
    hydrated: boolean;
    hasPtyId: boolean;
    newMode: TerminalColorSchemeMode;
  },
): Mode2031Decision {
  if (
    !prev.subscribed ||
    !input.hydrated ||
    !input.hasPtyId ||
    prev.lastPushedMode === input.newMode
  ) {
    return { state: prev, emit: null };
  }
  return {
    state: { subscribed: true, lastPushedMode: input.newMode },
    emit: mode2031SequenceFor(input.newMode),
  };
}
