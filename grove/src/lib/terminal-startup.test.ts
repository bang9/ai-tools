import { describe, expect, it } from "vitest";
import { buildTerminalPaneSeed } from "./terminal-startup";

describe("buildTerminalPaneSeed", () => {
  const pane = {
    launchCwd: "/tmp/project",
    scrollback: "pnpm test\r\n",
  };

  it("uses backend tmux capture for attached sessions", () => {
    expect(
      buildTerminalPaneSeed(pane, "pty-1", {
        sessionState: "attached",
        initialHydration: {
          text: "live attach buffer\r\n",
          truncated: false,
          source: "tmuxCapture",
        },
      }),
    ).toEqual({
      ptyId: "pty-1",
      launchCwd: "/tmp/project",
      initialScrollback: "live attach buffer\r\n",
      initialScrollbackSource: "tmuxCapture",
    });
  });

  it("does not replay fallback snapshot scrollback for attached sessions", () => {
    expect(
      buildTerminalPaneSeed(pane, "pty-1", {
        sessionState: "attached",
      }),
    ).toEqual({
      ptyId: "pty-1",
      launchCwd: "/tmp/project",
      initialScrollback: undefined,
      initialScrollbackSource: undefined,
    });
  });

  it("threads daemon-snapshot reattach metadata onto the seed for attached sessions", () => {
    expect(
      buildTerminalPaneSeed(pane, "pty-3", {
        sessionState: "attached",
        initialHydration: {
          text: "alt screen buffer",
          truncated: false,
          source: "daemonSnapshot",
          snapshotCols: 120,
          snapshotRows: 40,
          isAlternateScreen: true,
          pendingEscapeTailAnsi: "\x1b[38;2",
          kittyKeyboardFlags: 5,
          isColdRestore: true,
        },
      }),
    ).toEqual({
      ptyId: "pty-3",
      launchCwd: "/tmp/project",
      initialScrollback: "alt screen buffer",
      initialScrollbackSource: "daemonSnapshot",
      snapshotCols: 120,
      snapshotRows: 40,
      isAlternateScreen: true,
      pendingEscapeTailAnsi: "\x1b[38;2",
      kittyKeyboardFlags: 5,
      isColdRestore: true,
    });
  });

  it("collapses null daemon-snapshot wire fields to undefined", () => {
    expect(
      buildTerminalPaneSeed(pane, "pty-4", {
        sessionState: "attached",
        initialHydration: {
          text: "warm buffer",
          truncated: false,
          source: "daemonSnapshot",
          snapshotCols: null,
          snapshotRows: null,
          isAlternateScreen: null,
          pendingEscapeTailAnsi: null,
          kittyKeyboardFlags: null,
          isColdRestore: null,
        },
      }),
    ).toEqual({
      ptyId: "pty-4",
      launchCwd: "/tmp/project",
      initialScrollback: "warm buffer",
      initialScrollbackSource: "daemonSnapshot",
      snapshotCols: undefined,
      snapshotRows: undefined,
      isAlternateScreen: undefined,
      pendingEscapeTailAnsi: undefined,
      kittyKeyboardFlags: undefined,
      isColdRestore: undefined,
    });
  });

  it("uses pane snapshot scrollback for created sessions", () => {
    expect(
      buildTerminalPaneSeed(pane, "pty-2", {
        sessionState: "created",
        initialHydration: {
          text: "ignored\r\n",
          truncated: false,
          source: "tmuxCapture",
        },
      }),
    ).toEqual({
      ptyId: "pty-2",
      launchCwd: "/tmp/project",
      initialScrollback: "pnpm test\r\n",
      initialScrollbackSource: "snapshotFallback",
    });
  });
});
