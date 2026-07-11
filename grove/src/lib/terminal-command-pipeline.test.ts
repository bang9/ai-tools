import { describe, expect, it, vi } from "vitest";
import {
  executeTerminalCommand,
  isTerminalCommandEnabled,
  type TerminalCommandContext,
  type TerminalCommandDefinition,
} from "./terminal-command-pipeline";

function makeContext(overrides: Partial<TerminalCommandContext> = {}): TerminalCommandContext {
  return {
    activeWorktree: "/tmp/worktree",
    focusedPtyId: "pty-1",
    terminalCount: 2,
    splitTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    refreshTerminal: vi.fn(),
    mirrorTerminal: vi.fn(),
    sendText: vi.fn(),
    ...overrides,
  };
}

describe("terminal command pipeline", () => {
  it("disables focused-pty commands when no terminal is focused", () => {
    const command: TerminalCommandDefinition = {
      id: "terminal-close",
      label: "Close terminal",
      title: "Close Terminal",
      icon: "close",
      when: "focused-pty",
      steps: [{ type: "session", action: "close" }],
    };

    expect(isTerminalCommandEnabled(command, { focusedPtyId: null, terminalCount: 1 })).toBe(false);
  });

  it("executes session and pty steps in order", async () => {
    const context = makeContext();
    const command: TerminalCommandDefinition = {
      id: "custom-sequence",
      label: "Custom sequence",
      title: "Custom sequence",
      icon: "play",
      when: "focused-pty",
      steps: [
        {
          type: "pty",
          action: "send-text",
          text: "echo test",
          addNewline: true,
        },
        {
          type: "session",
          action: "split",
          direction: "vertical",
        },
      ],
    };

    await executeTerminalCommand(command, context);

    expect(context.sendText).toHaveBeenCalledWith("echo test", {
      addNewline: true,
    });
    expect(context.splitTerminal).toHaveBeenCalledWith("vertical");
  });

  it("routes mirror session steps through mirrorTerminal", async () => {
    const context = makeContext();
    const command: TerminalCommandDefinition = {
      id: "terminal-mirror",
      label: "Mirror to Global Terminal",
      title: "Mirror to Global Terminal",
      icon: "mirror",
      when: "focused-pty",
      steps: [{ type: "session", action: "mirror" }],
    };

    await executeTerminalCommand(command, context);

    expect(context.mirrorTerminal).toHaveBeenCalledTimes(1);
  });
});
