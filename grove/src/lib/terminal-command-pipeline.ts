export type TerminalCommandIcon =
  | "mirror"
  | "split-horizontal"
  | "split-vertical"
  | "close"
  | "refresh"
  | "play";

export type TerminalCommandAvailability =
  | "always"
  | "focused-pty"
  | "focused-pty-single"
  | "focused-pty-multiple";

export type TerminalCommandStep =
  | {
      type: "session";
      action: "split";
      direction: "horizontal" | "vertical";
    }
  | { type: "session"; action: "close" }
  | { type: "session"; action: "refresh" }
  | { type: "session"; action: "mirror" }
  | {
      type: "pty";
      action: "send-text";
      text: string;
      addNewline?: boolean;
    };

export interface TerminalCommandDefinition {
  id: string;
  label: string;
  title: string;
  icon: TerminalCommandIcon;
  when?: TerminalCommandAvailability;
  disableWhileExecuting?: boolean;
  steps: TerminalCommandStep[];
}

export interface TerminalCommandContext {
  activeWorktree: string | null;
  focusedPtyId: string | null;
  terminalCount: number;
  splitTerminal: (direction: "horizontal" | "vertical") => Promise<void> | void;
  closeTerminal: () => Promise<void> | void;
  refreshTerminal: () => Promise<void> | void;
  mirrorTerminal: () => void;
  sendText: (text: string, options?: { addNewline?: boolean }) => Promise<void> | void;
}

export function isTerminalCommandEnabled(
  command: TerminalCommandDefinition,
  context: Pick<TerminalCommandContext, "focusedPtyId" | "terminalCount">,
): boolean {
  switch (command.when ?? "always") {
    case "focused-pty":
      return Boolean(context.focusedPtyId);
    case "focused-pty-single":
      return Boolean(context.focusedPtyId) && context.terminalCount === 1;
    case "focused-pty-multiple":
      return Boolean(context.focusedPtyId) && context.terminalCount > 1;
    case "always":
      return true;
  }
}

export async function executeTerminalCommand(
  command: TerminalCommandDefinition,
  context: TerminalCommandContext,
): Promise<void> {
  if (!isTerminalCommandEnabled(command, context)) {
    return;
  }

  for (const step of command.steps) {
    switch (step.type) {
      case "session":
        if (step.action === "split") {
          await context.splitTerminal(step.direction);
        } else if (step.action === "mirror") {
          context.mirrorTerminal();
        } else if (step.action === "refresh") {
          await context.refreshTerminal();
        } else if (step.action === "close") {
          await context.closeTerminal();
        }
        break;
      case "pty":
        await context.sendText(step.text, {
          addNewline: step.addNewline,
        });
        break;
    }
  }
}
