import { describe, expect, it } from "vitest";
import {
  deriveKittyReArmBytes,
  deriveKittyReplayFlags,
  scanKittyReplayFlags,
} from "./terminal-kitty-replay";

describe("scanKittyReplayFlags", () => {
  it("returns 0 for a payload with no kitty sequences", () => {
    expect(scanKittyReplayFlags("hello \x1b[31mworld\x1b[0m")).toBe(0);
  });

  it("applies a push (CSI > N u) as an idempotent set", () => {
    expect(scanKittyReplayFlags("\x1b[>1u")).toBe(1);
    // A redelivered push must not stack; the effective flags stay the pushed
    // value rather than accumulating.
    expect(scanKittyReplayFlags("\x1b[>1u\x1b[>1u")).toBe(1);
  });

  it("takes the last push value when multiple distinct pushes appear", () => {
    expect(scanKittyReplayFlags("\x1b[>1u\x1b[>5u")).toBe(5);
  });

  it("pops (CSI < N u) back toward 0 (replayed pushes are stackless sets)", () => {
    // Replay semantics: pushes do not stack, so a following pop drains to 0.
    expect(scanKittyReplayFlags("\x1b[>5u\x1b[<u")).toBe(0);
  });

  it("honors the set form (CSI = flags u, mode 1 default)", () => {
    expect(scanKittyReplayFlags("\x1b[=7u")).toBe(7);
  });

  it("honors the OR form (mode 2)", () => {
    expect(scanKittyReplayFlags("\x1b[=1u\x1b[=4;2u")).toBe(5);
  });

  it("honors the AND-NOT form (mode 3)", () => {
    expect(scanKittyReplayFlags("\x1b[=7u\x1b[=1;3u")).toBe(6);
  });

  it("resets to 0 on RIS (ESC c)", () => {
    expect(scanKittyReplayFlags("\x1b[>5u\x1bc")).toBe(0);
  });

  it("resets flags on DECSTR soft reset (CSI ! p)", () => {
    expect(scanKittyReplayFlags("\x1b[>5u\x1b[!p")).toBe(0);
  });

  it("swaps flag slots across an alt-screen (1049) transition", () => {
    // Main gets 5; entering alt swaps to the (empty) alt slot; alt gets 9;
    // leaving alt restores the main slot's 5.
    expect(scanKittyReplayFlags("\x1b[>5u\x1b[?1049h\x1b[>9u")).toBe(9);
    expect(scanKittyReplayFlags("\x1b[>5u\x1b[?1049h\x1b[>9u\x1b[?1049l")).toBe(5);
  });

  it("accepts the CSI 8-bit introducer (0x9b)", () => {
    expect(scanKittyReplayFlags("\x9b=3u")).toBe(3);
  });
});

describe("deriveKittyReplayFlags", () => {
  it("prefers the daemon's authoritative snapshot flags over the payload", () => {
    // Payload scan would yield 1, but the daemon reports the live state as 5.
    expect(deriveKittyReplayFlags("\x1b[>1u", 5)).toBe(5);
  });

  it("trusts an explicit 0 from the daemon (kitty inactive)", () => {
    expect(deriveKittyReplayFlags("\x1b[>1u", 0)).toBe(0);
  });

  it("falls back to scanning the payload when flags are absent", () => {
    expect(deriveKittyReplayFlags("\x1b[>1u", undefined)).toBe(1);
  });

  it("ignores a non-finite flags value and scans the payload", () => {
    expect(deriveKittyReplayFlags("\x1b[>3u", Number.NaN)).toBe(3);
  });
});

describe("deriveKittyReArmBytes", () => {
  it("returns the set-all-flags sequence for a live kitty state", () => {
    expect(deriveKittyReArmBytes("", 5)).toBe("\x1b[=5u");
  });

  it("returns nothing when the protocol is inactive", () => {
    expect(deriveKittyReArmBytes("", 0)).toBe("");
    expect(deriveKittyReArmBytes("plain output", undefined)).toBe("");
  });

  it("re-arms from a payload push when the daemon reported no flags", () => {
    expect(deriveKittyReArmBytes("\x1b[>1u", undefined)).toBe("\x1b[=1u");
  });
});
