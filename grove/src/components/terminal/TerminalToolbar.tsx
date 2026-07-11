import { Columns2, Play, RotateCw, Rows2, ScreenShare, X } from "lucide-react";
import { useTerminalCommandPipeline } from "../../hooks/useTerminalCommandPipeline";
import type { TerminalCommandDefinition } from "../../lib/terminal-command-pipeline";
import { IconButton } from "../ui/button";
import { cn } from "../../lib/cn";

const terminalCommandIcons = {
  mirror: ScreenShare,
  "split-horizontal": Columns2,
  "split-vertical": Rows2,
  close: X,
  refresh: RotateCw,
  play: Play,
} satisfies Record<TerminalCommandDefinition["icon"], typeof ScreenShare>;

export default function TerminalToolbar() {
  const { commands, executeCommand, isCommandEnabled } = useTerminalCommandPipeline();

  return (
    <div
      className={cn(
        "flex items-center justify-end border-b border-border bg-sidebar px-2 h-9 shrink-0",
      )}
    >
      <div className={cn("flex items-center gap-1")}>
        {commands.filter(isCommandEnabled).map((command) => {
          const Icon = terminalCommandIcons[command.icon];
          return (
            <IconButton
              key={command.id}
              className={cn("h-7 w-7")}
              onClick={() => {
                executeCommand(command).catch(() => {});
              }}
              title={command.title}
            >
              <Icon className={cn("h-3.5 w-3.5")} />
            </IconButton>
          );
        })}
      </div>
    </div>
  );
}
