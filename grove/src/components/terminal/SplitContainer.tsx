import { memo, useCallback } from "react";
import type { SplitNode } from "../../types";
import TerminalInstance from "./TerminalInstance";
import { useTerminalStore } from "../../store/terminal";
import { cn } from "../../lib/cn";
import { requestTerminalLayoutSync } from "../../lib/terminal-layout-sync";
import ResizablePanelGroup from "../ui/resizable-panel-group";

interface Props {
  node: SplitNode;
  worktreePath: string;
  path?: number[];
}

function pathsEqual(left: number[] | undefined, right: number[] | undefined) {
  const leftLength = left?.length ?? 0;
  const rightLength = right?.length ?? 0;
  if (leftLength !== rightLength) {
    return false;
  }

  for (let i = 0; i < leftLength; i += 1) {
    if (left?.[i] !== right?.[i]) {
      return false;
    }
  }

  return true;
}

function SplitContainer({
  node,
  worktreePath,
  path = [],
}: Props) {
  const updateSizes = useTerminalStore((s) => s.updateSizes);
  const handleCommit = useCallback((ratios: number[]) => {
    updateSizes(worktreePath, path, ratios);
  }, [path, updateSizes, worktreePath]);

  if (node.type === "leaf") {
    return node.ptyId ? (
      <div className={cn("relative w-full h-full")}>
        <TerminalInstance
          paneId={node.id}
          ptyId={node.ptyId}
          worktreePath={worktreePath}
          label={node.label}
        />
      </div>
    ) : null;
  }

  return (
    <ResizablePanelGroup
      className={cn("h-full w-full")}
      id={node.id}
      vertical={node.type === "vertical"}
      ratios={node.sizes}
      onLayout={() => {
        requestTerminalLayoutSync({ source: "panelResize" });
      }}
      onCommit={handleCommit}
    >
      {node.children?.map((child, i) => (
        <ResizablePanelGroup.Pane
          key={child.id}
          preferredSize={node.sizes?.[i] !== undefined ? `${node.sizes[i] * 100}%` : undefined}
        >
          <SplitContainer
            node={child}
            worktreePath={worktreePath}
            path={[...path, i]}
          />
        </ResizablePanelGroup.Pane>
      ))}
    </ResizablePanelGroup>
  );
}

export default memo(SplitContainer, (prev, next) =>
  prev.node === next.node &&
  prev.worktreePath === next.worktreePath &&
  pathsEqual(prev.path, next.path),
);
