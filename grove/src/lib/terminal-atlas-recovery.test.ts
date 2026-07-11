import { describe, expect, it, vi } from "vitest";
import {
  AtlasRecoveryDebounce,
  ATLAS_RECOVERY_QUIET_MS,
  bytesContainNonAscii,
  type AtlasRecoveryTimer,
} from "./terminal-atlas-recovery";

// A fake timer that records the pending callback so a test can drive the
// trailing edge without wall-clock waits.
function makeFakeTimer() {
  let pending: (() => void) | null = null;
  let nextHandle = 1;
  const set = vi.fn((_delayMs: number, cb: () => void) => {
    pending = cb;
    return nextHandle++;
  });
  const clear = vi.fn((_handle: number) => {
    pending = null;
  });
  const timer: AtlasRecoveryTimer = { set, clear };
  return {
    timer,
    set,
    clear,
    fire: () => {
      const cb = pending;
      pending = null;
      cb?.();
    },
    hasPending: () => pending !== null,
  };
}

describe("AtlasRecoveryDebounce", () => {
  it("re-arms the timer on every request in a burst and fires once after quiet", () => {
    const fake = makeFakeTimer();
    const run = vi.fn();
    const debounce = new AtlasRecoveryDebounce({ run, timer: fake.timer, quietMs: 1_000 });

    for (let i = 0; i < 8; i += 1) {
      debounce.request();
    }

    // Quiet-wait debounce: each request clears the prior pending timer and
    // re-arms, so the deadline keeps sliding — 8 sets, 7 clears, nothing fired.
    expect(fake.set).toHaveBeenCalledTimes(8);
    expect(fake.clear).toHaveBeenCalledTimes(7);
    expect(fake.set).toHaveBeenLastCalledWith(1_000, expect.any(Function));
    expect(run).not.toHaveBeenCalled();
    expect(debounce.isPending()).toBe(true);

    // Trailing edge: only after the stream goes quiet for the full window does
    // recovery run — exactly once for the whole burst.
    fake.fire();
    expect(run).toHaveBeenCalledTimes(1);
    expect(debounce.isPending()).toBe(false);
  });

  it("arms a fresh window for a later burst after the first fired", () => {
    const fake = makeFakeTimer();
    const run = vi.fn();
    const debounce = new AtlasRecoveryDebounce({ run, timer: fake.timer });

    debounce.request();
    fake.fire();
    expect(run).toHaveBeenCalledTimes(1);

    // A new request after the window fired arms a new timer.
    debounce.request();
    expect(fake.set).toHaveBeenCalledTimes(2);
    fake.fire();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("uses the default >=1s quiet window when none is supplied", () => {
    const fake = makeFakeTimer();
    const debounce = new AtlasRecoveryDebounce({ run: vi.fn(), timer: fake.timer });
    debounce.request();
    expect(fake.set).toHaveBeenCalledWith(ATLAS_RECOVERY_QUIET_MS, expect.any(Function));
    expect(ATLAS_RECOVERY_QUIET_MS).toBeGreaterThanOrEqual(1_000);
  });

  it("cancel clears a pending recovery so it never fires", () => {
    const fake = makeFakeTimer();
    const run = vi.fn();
    const debounce = new AtlasRecoveryDebounce({ run, timer: fake.timer });

    debounce.request();
    expect(debounce.isPending()).toBe(true);
    debounce.cancel();
    expect(fake.clear).toHaveBeenCalledTimes(1);
    expect(debounce.isPending()).toBe(false);
    expect(fake.hasPending()).toBe(false);

    // A cancel with nothing pending is a no-op.
    debounce.cancel();
    expect(fake.clear).toHaveBeenCalledTimes(1);
  });
});

describe("bytesContainNonAscii", () => {
  it("is false for pure ASCII bytes", () => {
    expect(bytesContainNonAscii(new TextEncoder().encode("plain ascii 123\r\n"))).toBe(false);
    expect(bytesContainNonAscii(new Uint8Array([0x1b, 0x5b, 0x33, 0x32, 0x6d]))).toBe(false);
    expect(bytesContainNonAscii(new Uint8Array())).toBe(false);
  });

  it("is true when any byte is >= 0x80 (UTF-8 lead/trail of a risk glyph)", () => {
    expect(bytesContainNonAscii(new TextEncoder().encode("터미널"))).toBe(true);
    expect(bytesContainNonAscii(new TextEncoder().encode("status 🚀"))).toBe(true);
    expect(bytesContainNonAscii(new Uint8Array([0x41, 0x80]))).toBe(true);
  });
});
