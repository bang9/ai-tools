import { describe, expect, it } from "vitest";
import { shouldAttachPrimaryRuntime, shouldStartPipBroadcast } from "./broadcast-policy";

describe("broadcast policy", () => {
  describe("shouldAttachPrimaryRuntime", () => {
    it("keeps the source pane detached while broadcasting", () => {
      expect(shouldAttachPrimaryRuntime(true)).toBe(false);
    });

    it("allows the source pane to own the runtime when idle", () => {
      expect(shouldAttachPrimaryRuntime(false)).toBe(true);
    });
  });

  describe("shouldStartPipBroadcast", () => {
    it("starts PiP when leaving terminal with a focused non-mirrored pty", () => {
      expect(
        shouldStartPipBroadcast({
          isTerminal: false,
          wasTerminal: true,
          focusedPtyId: "pty-1",
          hasActivePip: false,
          isFocusedPtyMirroring: false,
          activeTabIsBrowser: false,
        }),
      ).toBe(true);
    });

    it("does not start PiP when the focused pty is mirrored", () => {
      expect(
        shouldStartPipBroadcast({
          isTerminal: false,
          wasTerminal: true,
          focusedPtyId: "pty-1",
          hasActivePip: false,
          isFocusedPtyMirroring: true,
          activeTabIsBrowser: false,
        }),
      ).toBe(false);
    });

    it("does not start PiP without a terminal-to-non-terminal transition", () => {
      expect(
        shouldStartPipBroadcast({
          isTerminal: false,
          wasTerminal: false,
          focusedPtyId: "pty-1",
          hasActivePip: false,
          isFocusedPtyMirroring: false,
          activeTabIsBrowser: false,
        }),
      ).toBe(false);
    });

    it("does not start PiP when the active tab is a native browser webview", () => {
      expect(
        shouldStartPipBroadcast({
          isTerminal: false,
          wasTerminal: true,
          focusedPtyId: "pty-1",
          hasActivePip: false,
          isFocusedPtyMirroring: false,
          activeTabIsBrowser: true,
        }),
      ).toBe(false);
    });
  });
});
