// Bracketed-paste sanitization for clipboard paste (command-injection fix).
//
// xterm 6.0.0's built-in paste wraps clipboard text in ESC[200~ / ESC[201~ with
// NO stripping of embedded ESC bytes. Pasting text that itself contains
// `\x1b[201~; rm -rf ~\n` closes the bracketed-paste frame early, so the shell
// runs the tail as live keystrokes. We take over the 'paste' event on a
// capture-phase listener above xterm's own textarea/screen listeners, replicate
// xterm's exact newline + bracket behavior, and neutralize every embedded ESC.

const ESCAPE = "\u001b";
export const BRACKETED_PASTE_START = `${ESCAPE}[200~`;
export const BRACKETED_PASTE_END = `${ESCAPE}[201~`;

// Why: xterm's prepareTextForTerminal collapses CRLF/LF to a bare CR before it
// reaches the PTY; matching it keeps non-bracketed paste byte-identical to today.
const NEWLINE_RE = /\r?\n/g;

export function normalizePasteNewlines(text: string): string {
  return text.replace(NEWLINE_RE, "\r");
}

// Why: an embedded ESC (e.g. a pasted `\x1b[201~` from scrollback) would close
// the bracketed-paste frame early and run the tail as keystrokes. Replacing ESC
// with its printable substitute (U+241B) neutralizes every framing escape while
// staying visible. indexOf/slice avoids allocating a split array on escape-heavy
// payloads.
export function sanitizeBracketedPasteText(text: string): string {
  let escapeIndex = text.indexOf(ESCAPE);
  if (escapeIndex === -1) {
    return text;
  }

  let sanitized = "";
  let start = 0;
  while (escapeIndex !== -1) {
    sanitized += `${text.slice(start, escapeIndex)}\u241b`;
    start = escapeIndex + ESCAPE.length;
    escapeIndex = text.indexOf(ESCAPE, start);
  }
  return sanitized + text.slice(start);
}

// Why: the exact bytes grove sends for a paste, pure so the security-critical
// decision (normalize -> conditionally wrap+sanitize) is testable without a DOM.
// Bracketed mode ON: wrap the sanitized text in the paste frame. OFF: send the
// normalized text verbatim, exactly as xterm's non-bracketed paste does today.
export function buildPasteOutput(params: {
  clipboardText: string;
  bracketedPasteMode: boolean;
}): string {
  const normalized = normalizePasteNewlines(params.clipboardText);
  if (!params.bracketedPasteMode) {
    return normalized;
  }
  return `${BRACKETED_PASTE_START}${sanitizeBracketedPasteText(normalized)}${BRACKETED_PASTE_END}`;
}

type ClipboardDataLike = {
  getData: (type: string) => string;
};

// Why: read the paste event by shape (clipboardData + the two methods we call)
// rather than instanceof ClipboardEvent — the node test env has no ClipboardEvent
// global, and the DOM ClipboardEvent is structurally assignable to this.
type PasteEventLike = {
  clipboardData?: ClipboardDataLike | null;
  preventDefault: () => void;
  stopImmediatePropagation: () => void;
};

export interface BracketedPasteSanitizerOptions {
  /** The terminal container — a strict ancestor of xterm's paste targets. */
  container: Pick<HTMLElement, "addEventListener" | "removeEventListener">;
  /** Live bracketed-paste mode of the terminal (term.modes.bracketedPasteMode). */
  isBracketedPasteMode: () => boolean;
  /** Live IME composition state for this pane (runtime.isComposing()). */
  isComposing: () => boolean;
  /** Sends the resolved paste string through the runtime's PTY input queue. */
  sendInput: (text: string) => void;
}

/**
 * Installs a capture-phase 'paste' listener on the terminal container so it
 * preempts xterm 6.0.0's own bubble-phase listeners (attached to `this.textarea`
 * and `this.element`, both descendants of the container). Returns a cleanup fn.
 *
 * The listener:
 *  - Defers entirely to xterm while an IME composition is live (early return, no
 *    preventDefault) so it never corrupts an in-progress Hangul/CJK composition.
 *  - Ignores non-text pastes (no `text/plain`) by leaving them to xterm.
 *  - Otherwise preventDefault + stopImmediatePropagation to stop xterm's own
 *    paste path from firing (no double paste), then sends the sanitized bytes
 *    through the runtime's input queue exactly once.
 */
export function installBracketedPasteSanitizer(
  options: BracketedPasteSanitizerOptions,
): () => void {
  const handler = (event: Event): void => {
    const pasteEvent = event as PasteEventLike;
    // Why: an active IME composition owns the paste/input path; taking over here
    // would strip the in-flight composition. Defer without preventDefault.
    if (options.isComposing()) {
      return;
    }

    const clipboardData = pasteEvent.clipboardData;
    if (!clipboardData) {
      return;
    }

    const text = clipboardData.getData("text/plain");
    if (text.length === 0) {
      // No text payload (e.g. an image): let xterm handle it, don't preempt.
      return;
    }

    // Preempt xterm's textarea/screen paste listeners so the clipboard bytes are
    // written exactly once, through our sanitizing path.
    pasteEvent.preventDefault();
    pasteEvent.stopImmediatePropagation();

    options.sendInput(
      buildPasteOutput({
        clipboardText: text,
        bracketedPasteMode: options.isBracketedPasteMode(),
      }),
    );
  };

  options.container.addEventListener("paste", handler, true);
  return () => {
    options.container.removeEventListener("paste", handler, true);
  };
}
