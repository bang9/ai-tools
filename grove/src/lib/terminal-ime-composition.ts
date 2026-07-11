// Why: authoritative IME composition-active state for a terminal pane. The
// per-keydown isComposing guard (terminal-input.ts) can only answer "is this
// keydown part of a composition?" — it cannot answer "is Hangul being composed
// right now?" outside a keydown. A later capture-phase bracketed-paste
// sanitizer must consult isActive() so it never corrupts a live composition.

export type TerminalImeCompositionTracker = {
  isActive: () => boolean;
  dispose: () => void;
};

// Why: some IMEs drop compositionend; a missed one would strand active=true
// forever, keeping IME-sensitive paths defensive indefinitely. Expire stale
// composition state so those paths recover on their own.
export const TERMINAL_IME_COMPOSITION_STALE_EXPIRY_MS = 10_000;

// Why: grove observes through a plain EventTarget contract (addEventListener /
// removeEventListener) and reads event fields by shape rather than instanceof —
// this keeps the module usable in the node test env, where CompositionEvent /
// InputEvent globals do not exist, and needs no @xterm type import.
type CompositionEventLike = { data?: string | null };
type InputEventLike = { inputType?: string };

export function installTerminalImeCompositionTracker(
  terminalElement: HTMLElement | null | undefined,
  options?: { now?: () => number },
): TerminalImeCompositionTracker {
  const now = options?.now ?? ((): number => Date.now());
  let active = false;
  let lastCompositionEventAt: number | null = null;

  const isActiveAt = (at: number): boolean =>
    active &&
    (lastCompositionEventAt === null ||
      at - lastCompositionEventAt <= TERMINAL_IME_COMPOSITION_STALE_EXPIRY_MS);

  if (!terminalElement) {
    return { isActive: () => active, dispose: () => undefined };
  }

  const markActive = (): void => {
    active = true;
    lastCompositionEventAt = now();
  };
  const updateComposition = (event: Event): void => {
    lastCompositionEventAt = now();
    // Why: Sogou/fcitx emit empty compositionupdate data while the candidate
    // popup is still open — empty data must not deactivate. Only compositionend,
    // non-composition input, and blur own deactivation.
    const data = (event as CompositionEventLike).data;
    if (data === undefined || data === "") {
      return;
    }
    active = true;
  };
  const handleCompositionEnd = (): void => {
    active = false;
  };
  const handleInput = (event: Event): void => {
    // Why: insertCompositionText is the IME's own intermediate commit — treating
    // it as ordinary typing would clear active state mid-composition.
    if ((event as InputEventLike).inputType === "insertCompositionText") {
      return;
    }
    active = false;
  };
  const markInactive = (): void => {
    active = false;
    lastCompositionEventAt = null;
  };

  terminalElement.addEventListener("compositionstart", markActive, true);
  terminalElement.addEventListener("compositionupdate", updateComposition, true);
  terminalElement.addEventListener("compositionend", handleCompositionEnd, true);
  terminalElement.addEventListener("input", handleInput, true);
  terminalElement.addEventListener("blur", markInactive, true);

  return {
    isActive: () => isActiveAt(now()),
    dispose: () => {
      terminalElement.removeEventListener("compositionstart", markActive, true);
      terminalElement.removeEventListener("compositionupdate", updateComposition, true);
      terminalElement.removeEventListener("compositionend", handleCompositionEnd, true);
      terminalElement.removeEventListener("input", handleInput, true);
      terminalElement.removeEventListener("blur", markInactive, true);
    },
  };
}
