import { describe, expect, it } from "vitest";
import {
  installTerminalImeCompositionTracker,
  TERMINAL_IME_COMPOSITION_STALE_EXPIRY_MS,
  type TerminalImeCompositionTracker,
} from "./terminal-ime-composition";

// Why: grove runs vitest in the node environment (no DOM), so drive a bare
// EventTarget and count add/remove calls to prove dispose leaves no listeners.
function makeTarget() {
  const base = new EventTarget();
  let listeners = 0;
  // Why: node's EventTarget won't match a boolean-capture listener on remove
  // (only an options object), unlike real DOM — normalize so remove matches add.
  const normalize = (capture?: boolean | AddEventListenerOptions) =>
    typeof capture === "boolean" ? { capture } : capture;
  const element = {
    addEventListener(
      type: string,
      handler: EventListenerOrEventListenerObject,
      capture?: boolean | AddEventListenerOptions,
    ) {
      listeners++;
      base.addEventListener(type, handler, normalize(capture));
    },
    removeEventListener(
      type: string,
      handler: EventListenerOrEventListenerObject,
      capture?: boolean | EventListenerOptions,
    ) {
      listeners--;
      base.removeEventListener(type, handler, normalize(capture));
    },
  } as unknown as HTMLElement;
  return { element, base, listenerCount: () => listeners };
}

type Harness = {
  tracker: TerminalImeCompositionTracker;
  advance: (ms: number) => void;
  composition: (
    type: "compositionstart" | "compositionupdate" | "compositionend",
    data: string,
  ) => void;
  input: (inputType: string) => void;
  blur: () => void;
  listenerCount: () => number;
};

function installHarness(): Harness {
  let clock = 0;
  const { element, base, listenerCount } = makeTarget();
  const tracker = installTerminalImeCompositionTracker(element, { now: () => clock });
  return {
    tracker,
    listenerCount,
    advance: (ms) => {
      clock += ms;
    },
    composition: (type, data) => {
      const event = new Event(type);
      Object.defineProperty(event, "data", { value: data });
      base.dispatchEvent(event);
    },
    input: (inputType) => {
      const event = new Event("input");
      Object.defineProperty(event, "inputType", { value: inputType });
      base.dispatchEvent(event);
    },
    blur: () => {
      base.dispatchEvent(new Event("blur"));
    },
  };
}

describe("installTerminalImeCompositionTracker", () => {
  it("activates on compositionstart and clears through compositionend", () => {
    const harness = installHarness();
    expect(harness.tracker.isActive()).toBe(false);
    harness.composition("compositionstart", "");
    expect(harness.tracker.isActive()).toBe(true);
    harness.composition("compositionupdate", "한");
    expect(harness.tracker.isActive()).toBe(true);
    harness.composition("compositionend", "한");
    expect(harness.tracker.isActive()).toBe(false);
  });

  it("stays active through Sogou/fcitx-style empty compositionupdate", () => {
    const harness = installHarness();
    harness.composition("compositionstart", "");
    harness.composition("compositionupdate", "ni");
    harness.composition("compositionupdate", "");
    expect(harness.tracker.isActive()).toBe(true);
  });

  it("expires stale active state after a missed compositionend", () => {
    const harness = installHarness();
    harness.composition("compositionstart", "");
    harness.advance(TERMINAL_IME_COMPOSITION_STALE_EXPIRY_MS);
    expect(harness.tracker.isActive()).toBe(true);
    harness.advance(1);
    expect(harness.tracker.isActive()).toBe(false);
  });

  it("refreshes the expiry window on later composition activity", () => {
    const harness = installHarness();
    harness.composition("compositionstart", "");
    harness.advance(TERMINAL_IME_COMPOSITION_STALE_EXPIRY_MS);
    harness.composition("compositionupdate", "");
    harness.advance(TERMINAL_IME_COMPOSITION_STALE_EXPIRY_MS);
    expect(harness.tracker.isActive()).toBe(true);
  });

  it("does not clear on insertCompositionText input", () => {
    const harness = installHarness();
    harness.composition("compositionstart", "");
    harness.input("insertCompositionText");
    expect(harness.tracker.isActive()).toBe(true);
  });

  it("clears on ordinary non-composition input", () => {
    const harness = installHarness();
    harness.composition("compositionstart", "");
    harness.input("insertText");
    expect(harness.tracker.isActive()).toBe(false);
  });

  it("clears on blur", () => {
    const harness = installHarness();
    harness.composition("compositionstart", "");
    harness.blur();
    expect(harness.tracker.isActive()).toBe(false);
  });

  it("handles a missing terminal element", () => {
    const tracker = installTerminalImeCompositionTracker(null);
    expect(tracker.isActive()).toBe(false);
    expect(() => tracker.dispose()).not.toThrow();
  });

  it("stops tracking after dispose and removes every listener", () => {
    const harness = installHarness();
    expect(harness.listenerCount()).toBe(5);
    harness.tracker.dispose();
    expect(harness.listenerCount()).toBe(0);
    harness.composition("compositionstart", "");
    expect(harness.tracker.isActive()).toBe(false);
  });
});
