import { describe, expect, it, vi } from "vitest";
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  buildPasteOutput,
  installBracketedPasteSanitizer,
  normalizePasteNewlines,
  sanitizeBracketedPasteText,
} from "./terminal-bracketed-paste";

const ESC = "\u001b";
const INERT_ESC = "\u241b";

describe("sanitizeBracketedPasteText", () => {
  it("returns text unchanged when it contains no ESC", () => {
    expect(sanitizeBracketedPasteText("plain text")).toBe("plain text");
  });

  it("replaces an embedded ESC[201~ so it cannot close the paste frame early", () => {
    // Why: this is the injection payload — a pasted close marker must become inert.
    expect(sanitizeBracketedPasteText(`before${ESC}[201~; rm -rf ~`)).toBe(
      `before${INERT_ESC}[201~; rm -rf ~`,
    );
  });

  it("replaces an embedded ESC[200~ opener as well", () => {
    expect(sanitizeBracketedPasteText(`a${ESC}[200~b`)).toBe(`a${INERT_ESC}[200~b`);
  });

  it("replaces every ESC in an escape-heavy payload", () => {
    const text = Array.from({ length: 256 }, (_v, i) => `p${i}${ESC}[201~`).join("");
    const sanitized = sanitizeBracketedPasteText(text);
    expect(sanitized).not.toContain(ESC);
    expect(sanitized).toContain(`${INERT_ESC}[201~`);
  });

  it("does not allocate a split array (indexOf/slice scan)", () => {
    const text = Array.from({ length: 128 }, () => `${ESC}x`).join("");
    const splitSpy = vi.spyOn(String.prototype, "split");
    sanitizeBracketedPasteText(text);
    const calls = splitSpy.mock.calls.length;
    splitSpy.mockRestore();
    expect(calls).toBe(0);
  });
});

describe("normalizePasteNewlines", () => {
  it("collapses CRLF and LF to a bare CR (xterm parity)", () => {
    expect(normalizePasteNewlines("a\r\nb\nc")).toBe("a\rb\rc");
  });

  it("leaves a lone CR untouched", () => {
    expect(normalizePasteNewlines("a\rb")).toBe("a\rb");
  });
});

describe("buildPasteOutput", () => {
  it("wraps + sanitizes when bracketed paste mode is on", () => {
    const out = buildPasteOutput({
      clipboardText: `echo hi${ESC}[201~; rm -rf ~\ntail`,
      bracketedPasteMode: true,
    });
    // The only real ESC[201~ is the trailing framing closer; the embedded one is inert.
    expect(out).toBe(
      `${BRACKETED_PASTE_START}echo hi${INERT_ESC}[201~; rm -rf ~\rtail${BRACKETED_PASTE_END}`,
    );
    // Exactly one real closer marker survives.
    expect(out.split(BRACKETED_PASTE_END)).toHaveLength(2);
  });

  it("sends plain normalized text when bracketed paste mode is off", () => {
    const out = buildPasteOutput({
      clipboardText: `line1\nline2${ESC}[201~`,
      bracketedPasteMode: false,
    });
    // Non-bracketed matches xterm today: newline normalization only, ESC kept as-is.
    expect(out).toBe(`line1\rline2${ESC}[201~`);
    expect(out).not.toContain(BRACKETED_PASTE_START);
  });
});

type FakeListener = { handler: (event: Event) => void; capture: boolean };

function createFakeContainer() {
  const listeners: FakeListener[] = [];
  const container = {
    addEventListener: (_type: string, handler: (event: Event) => void, capture: boolean) => {
      listeners.push({ handler, capture });
    },
    removeEventListener: (_type: string, handler: (event: Event) => void) => {
      const index = listeners.findIndex((l) => l.handler === handler);
      if (index !== -1) {
        listeners.splice(index, 1);
      }
    },
  };
  const dispatch = (event: Event) => {
    for (const listener of listeners.slice()) {
      listener.handler(event);
    }
  };
  return { container, listeners, dispatch };
}

function createPasteEvent(text: string | null) {
  return {
    clipboardData: text === null ? null : { getData: () => text },
    preventDefault: vi.fn(),
    stopImmediatePropagation: vi.fn(),
  } as unknown as Event & {
    preventDefault: ReturnType<typeof vi.fn>;
    stopImmediatePropagation: ReturnType<typeof vi.fn>;
  };
}

describe("installBracketedPasteSanitizer", () => {
  it("installs a capture-phase paste listener", () => {
    const { container, listeners } = createFakeContainer();
    installBracketedPasteSanitizer({
      container: container as unknown as HTMLElement,
      isBracketedPasteMode: () => true,
      isComposing: () => false,
      sendInput: vi.fn(),
    });
    expect(listeners).toHaveLength(1);
    expect(listeners[0].capture).toBe(true);
  });

  it("sanitizes clipboard bytes and sends exactly one wrapped payload (no double paste)", () => {
    const { container, dispatch } = createFakeContainer();
    const sendInput = vi.fn();
    installBracketedPasteSanitizer({
      container: container as unknown as HTMLElement,
      isBracketedPasteMode: () => true,
      isComposing: () => false,
      sendInput,
    });

    const event = createPasteEvent(`safe${ESC}[201~; rm -rf ~`);
    dispatch(event);

    // Exactly one payload reaches the queue, wrapped once, embedded ESC inert.
    expect(sendInput).toHaveBeenCalledTimes(1);
    expect(sendInput).toHaveBeenCalledWith(
      `${BRACKETED_PASTE_START}safe${INERT_ESC}[201~; rm -rf ~${BRACKETED_PASTE_END}`,
    );
    // preventDefault + stopImmediatePropagation preempt xterm's own paste path.
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.stopImmediatePropagation).toHaveBeenCalledTimes(1);
  });

  it("defers entirely to xterm while an IME composition is active", () => {
    const { container, dispatch } = createFakeContainer();
    const sendInput = vi.fn();
    installBracketedPasteSanitizer({
      container: container as unknown as HTMLElement,
      isBracketedPasteMode: () => true,
      isComposing: () => true,
      sendInput,
    });

    const event = createPasteEvent("한글");
    dispatch(event);

    // Queue untouched and no preventDefault: xterm owns the composition path.
    expect(sendInput).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
  });

  it("sends plain normalized text when bracketed paste mode is off", () => {
    const { container, dispatch } = createFakeContainer();
    const sendInput = vi.fn();
    installBracketedPasteSanitizer({
      container: container as unknown as HTMLElement,
      isBracketedPasteMode: () => false,
      isComposing: () => false,
      sendInput,
    });

    const event = createPasteEvent("a\nb");
    dispatch(event);

    expect(sendInput).toHaveBeenCalledTimes(1);
    expect(sendInput).toHaveBeenCalledWith("a\rb");
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.stopImmediatePropagation).toHaveBeenCalledTimes(1);
  });

  it("leaves a non-text paste (no text/plain) to xterm", () => {
    const { container, dispatch } = createFakeContainer();
    const sendInput = vi.fn();
    installBracketedPasteSanitizer({
      container: container as unknown as HTMLElement,
      isBracketedPasteMode: () => true,
      isComposing: () => false,
      sendInput,
    });

    const emptyText = createPasteEvent("");
    dispatch(emptyText);
    const noClipboard = createPasteEvent(null);
    dispatch(noClipboard);

    expect(sendInput).not.toHaveBeenCalled();
    expect(emptyText.preventDefault).not.toHaveBeenCalled();
    expect(noClipboard.preventDefault).not.toHaveBeenCalled();
  });

  it("removes the listener on cleanup", () => {
    const { container, listeners } = createFakeContainer();
    const remove = installBracketedPasteSanitizer({
      container: container as unknown as HTMLElement,
      isBracketedPasteMode: () => true,
      isComposing: () => false,
      sendInput: vi.fn(),
    });
    expect(listeners).toHaveLength(1);
    remove();
    expect(listeners).toHaveLength(0);
  });
});
