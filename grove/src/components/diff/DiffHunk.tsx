import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { DiffHunk as DiffHunkType } from "../../types";
import { cn } from "../../lib/cn";
import {
  buildHighlightedBlocks,
  type HighlightedBlock,
  type HighlightedGroup,
  type HighlightedLine,
} from "./intraline";

interface Props {
  hunk: DiffHunkType;
  hunkIndex: number;
  filePath: string;
  isFirst: boolean;
  selectedLines: Set<number>;
  isStaged: boolean;
  onStageHunk?: (filePath: string, hunkIndex: number) => void;
  onUnstageHunk?: (filePath: string, hunkIndex: number) => void;
  onDiscardHunk?: (filePath: string, hunkIndex: number) => void;
  onStageLines?: (filePath: string, hunkIndex: number, lineIndices: number[]) => void;
  onUnstageLines?: (filePath: string, hunkIndex: number, lineIndices: number[]) => void;
  onGutterClick: (lineIndex: number, shiftKey: boolean) => void;
  onGutterMouseDown: (lineIndex: number) => void;
  onGutterMouseEnter: (lineIndex: number, buttons: number) => void;
  onGutterMouseUp: () => void;
}

export default function DiffHunk({
  hunk,
  hunkIndex,
  filePath,
  isFirst,
  selectedLines,
  isStaged,
  onStageHunk,
  onUnstageHunk,
  onDiscardHunk,
  onStageLines,
  onUnstageLines,
  onGutterClick,
  onGutterMouseDown,
  onGutterMouseEnter,
  onGutterMouseUp,
}: Props) {
  const [collapsed, setCollapsed] = useState(false);

  // Get selected lines that belong to this hunk
  const selectedInHunk = useMemo(
    () => hunk.lines.map((line) => line.index).filter((index) => selectedLines.has(index)),
    [hunk.lines, selectedLines],
  );
  const highlightedBlocks = useMemo(() => buildHighlightedBlocks(hunk.lines), [hunk.lines]);

  const handleStage = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (selectedInHunk.length > 0 && onStageLines) {
      onStageLines(filePath, hunkIndex, selectedInHunk);
    } else {
      onStageHunk?.(filePath, hunkIndex);
    }
  };

  const handleUnstage = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (selectedInHunk.length > 0 && onUnstageLines) {
      onUnstageLines(filePath, hunkIndex, selectedInHunk);
    } else {
      onUnstageHunk?.(filePath, hunkIndex);
    }
  };

  return (
    <div className={cn({ "border-t border-border": !isFirst })}>
      {/* Hunk header */}
      <div
        className={cn("flex items-center gap-2 px-3 h-[30px] select-none")}
        style={{ background: "rgba(99, 163, 255, 0.04)", borderBottom: "1px solid rgba(255, 255, 255, 0.04)" }}
      >
        <button
          className={cn("flex items-center justify-center w-[18px] h-[18px] shrink-0 rounded hover:bg-secondary transition-colors cursor-pointer text-muted-foreground")}
          onClick={() => setCollapsed((prev) => !prev)}
          aria-label={collapsed ? "Expand hunk" : "Collapse hunk"}
        >
          {collapsed ? (
            <ChevronRight size={14} strokeWidth={2} />
          ) : (
            <ChevronDown size={14} strokeWidth={2} />
          )}
        </button>
        <span className={cn("min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground")}>
          {hunk.header}
        </span>
        {(onStageHunk || onUnstageHunk || onDiscardHunk) && (
          <div className={cn("flex items-center gap-1 shrink-0")}>
            {isStaged ? (
              <button
                type="button"
                className={cn("px-2 py-0.5 text-[10px] rounded cursor-pointer border border-border bg-secondary/50 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors")}
                onClick={handleUnstage}
              >
                {selectedInHunk.length > 0 ? `Unstage ${selectedInHunk.length} lines` : "Unstage"}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className={cn("px-2 py-0.5 text-[10px] rounded cursor-pointer border border-border bg-secondary/50 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors")}
                  onClick={handleStage}
                >
                  {selectedInHunk.length > 0 ? `Stage ${selectedInHunk.length} lines` : "Stage"}
                </button>
                <button
                  type="button"
                  className={cn("px-2 py-0.5 text-[10px] rounded cursor-pointer border border-border bg-secondary/50 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors")}
                  onClick={(e) => { e.stopPropagation(); onDiscardHunk?.(filePath, hunkIndex); }}
                >
                  Discard
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Lines grouped by type */}
      {!collapsed &&
        highlightedBlocks.map((block, index) =>
          block.kind === "paired" ? (
            <PairedLineGroupView
              key={blockKey(block, index)}
              remove={block.remove}
              add={block.add}
              selectedLines={selectedLines}
              onGutterClick={onGutterClick}
              onGutterMouseDown={onGutterMouseDown}
              onGutterMouseEnter={onGutterMouseEnter}
              onGutterMouseUp={onGutterMouseUp}
            />
          ) : (
            <LineGroupView
              key={blockKey(block, index)}
              type={block.group.type}
              lines={block.group.lines}
              selectedLines={selectedLines}
              onGutterClick={onGutterClick}
              onGutterMouseDown={onGutterMouseDown}
              onGutterMouseEnter={onGutterMouseEnter}
              onGutterMouseUp={onGutterMouseUp}
            />
          ),
        )}
    </div>
  );
}

function blockKey(block: HighlightedBlock, fallbackIndex: number): string {
  if (block.kind === "paired") {
    return `paired-${block.remove.lines[0]?.line.index ?? fallbackIndex}`;
  }

  return `group-${block.group.lines[0]?.line.index ?? fallbackIndex}`;
}

function LineGroupView({
  type,
  lines,
  selectedLines,
  onGutterClick,
  onGutterMouseDown,
  onGutterMouseEnter,
  onGutterMouseUp,
}: {
  type: HighlightedGroup["type"];
  lines: HighlightedLine[];
  selectedLines: Set<number>;
  onGutterClick: (lineIndex: number, shiftKey: boolean) => void;
  onGutterMouseDown: (lineIndex: number) => void;
  onGutterMouseEnter: (lineIndex: number, buttons: number) => void;
  onGutterMouseUp: () => void;
}) {
  const style = getGroupStyle(type);

  return (
    <div
      className="flex"
      style={{
        backgroundColor: style.containerBg,
        borderLeft: `2px solid ${style.borderColor}`,
      }}
    >
      <GroupGutterView
        type={type}
        lines={lines}
        selectedLines={selectedLines}
        onGutterClick={onGutterClick}
        onGutterMouseDown={onGutterMouseDown}
        onGutterMouseEnter={onGutterMouseEnter}
        onGutterMouseUp={onGutterMouseUp}
      />
      <div className={cn("flex-1 overflow-x-auto overflow-y-hidden diff-line-content")}>
        <GroupCodeRows type={type} lines={lines} selectedLines={selectedLines} />
      </div>
    </div>
  );
}

function PairedLineGroupView({
  remove,
  add,
  selectedLines,
  onGutterClick,
  onGutterMouseDown,
  onGutterMouseEnter,
  onGutterMouseUp,
}: {
  remove: HighlightedGroup;
  add: HighlightedGroup;
  selectedLines: Set<number>;
  onGutterClick: (lineIndex: number, shiftKey: boolean) => void;
  onGutterMouseDown: (lineIndex: number) => void;
  onGutterMouseEnter: (lineIndex: number, buttons: number) => void;
  onGutterMouseUp: () => void;
}) {
  return (
    <div className="flex">
      <div className="shrink-0">
        <GroupGutterView
          type={remove.type}
          lines={remove.lines}
          selectedLines={selectedLines}
          onGutterClick={onGutterClick}
          onGutterMouseDown={onGutterMouseDown}
          onGutterMouseEnter={onGutterMouseEnter}
          onGutterMouseUp={onGutterMouseUp}
        />
        <GroupGutterView
          type={add.type}
          lines={add.lines}
          selectedLines={selectedLines}
          onGutterClick={onGutterClick}
          onGutterMouseDown={onGutterMouseDown}
          onGutterMouseEnter={onGutterMouseEnter}
          onGutterMouseUp={onGutterMouseUp}
        />
      </div>
      <div className={cn("flex-1 overflow-x-auto overflow-y-hidden diff-line-content")}>
        <GroupCodeRows type={remove.type} lines={remove.lines} selectedLines={selectedLines} />
        <GroupCodeRows type={add.type} lines={add.lines} selectedLines={selectedLines} />
      </div>
    </div>
  );
}

function GroupGutterView({
  type,
  lines,
  selectedLines,
  onGutterClick,
  onGutterMouseDown,
  onGutterMouseEnter,
  onGutterMouseUp,
}: {
  type: HighlightedGroup["type"];
  lines: HighlightedLine[];
  selectedLines: Set<number>;
  onGutterClick: (lineIndex: number, shiftKey: boolean) => void;
  onGutterMouseDown: (lineIndex: number) => void;
  onGutterMouseEnter: (lineIndex: number, buttons: number) => void;
  onGutterMouseUp: () => void;
}) {
  const style = getGroupStyle(type);
  const isContext = type === "context";

  return (
    <div
      className="shrink-0"
      style={{
        backgroundColor: style.gutterBg,
        borderLeft: `2px solid ${style.borderColor}`,
      }}
    >
        {lines.map((line) => {
          const isSelectable = !isContext;
          const isSelected = isSelectable && selectedLines.has(line.line.index);

          return (
            <div
              key={line.line.index}
              data-gutter-line={isSelectable ? "" : undefined}
              className={cn("flex min-h-[20px] leading-[20px] font-mono text-[12px]", {
                "cursor-pointer": isSelectable,
              })}
              style={isSelected ? { boxShadow: `inset 3px 0 0 ${style.selectedBorderColor}` } : undefined}
              onClick={isSelectable ? (e) => { e.stopPropagation(); onGutterClick(line.line.index, e.shiftKey); } : undefined}
              onMouseDown={isSelectable ? () => onGutterMouseDown(line.line.index) : undefined}
              onMouseEnter={isSelectable ? (e) => onGutterMouseEnter(line.line.index, e.buttons) : undefined}
              onMouseUp={isSelectable ? onGutterMouseUp : undefined}
            >
              <span
                className={cn("w-[32px] text-right pr-1.5 text-[11px] select-none")}
                style={{ color: "rgba(255, 255, 255, 0.15)" }}
              >
                {line.line.oldLineNumber ?? ""}
              </span>
              <span
                className={cn("w-[32px] text-right pr-1.5 text-[11px] select-none")}
                style={{ color: "rgba(255, 255, 255, 0.15)" }}
              >
                {line.line.newLineNumber ?? ""}
              </span>
              <span
                className={cn("w-[18px] text-center select-none font-medium")}
                style={{ color: style.prefixColor }}
              >
                {style.prefix}
              </span>
            </div>
          );
        })}
    </div>
  );
}

function GroupCodeRows({
  type,
  lines,
  selectedLines,
}: {
  type: HighlightedGroup["type"];
  lines: HighlightedLine[];
  selectedLines: Set<number>;
}) {
  const style = getGroupStyle(type);
  const isContext = type === "context";

  return (
    <div style={{ backgroundColor: style.containerBg }}>
      {lines.map((line) => {
        const isSelectable = !isContext;
        const isSelected = isSelectable && selectedLines.has(line.line.index);

        return (
          <div
            key={line.line.index}
            className={cn("min-h-[20px] leading-[20px] font-mono text-[12px] whitespace-pre pr-3", {
              "text-foreground/80": isContext,
            })}
            style={isSelected ? { backgroundColor: style.selectedRowBg } : undefined}
          >
            {line.segments.map((segment, index) => (
              <span
                key={index}
                className={cn({ "rounded-[2px]": segment.emphasis })}
                style={segment.emphasis ? { backgroundColor: style.emphasisBg } : undefined}
              >
                {segment.text}
              </span>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function getGroupStyle(type: HighlightedGroup["type"]) {
  if (type === "add") {
    return {
      containerBg: "rgba(63, 185, 80, 0.07)",
      gutterBg: "rgba(63, 185, 80, 0.04)",
      prefixColor: "rgba(63, 185, 80, 0.7)",
      prefix: "+",
      borderColor: "rgba(63, 185, 80, 0.3)",
      selectedBorderColor: "rgba(63, 185, 80, 0.8)",
      selectedRowBg: "rgba(46, 160, 67, 0.15)",
      emphasisBg: "rgba(63, 185, 80, 0.18)",
    };
  }

  if (type === "remove") {
    return {
      containerBg: "rgba(248, 81, 73, 0.07)",
      gutterBg: "rgba(248, 81, 73, 0.04)",
      prefixColor: "rgba(248, 81, 73, 0.7)",
      prefix: "-",
      borderColor: "rgba(248, 81, 73, 0.3)",
      selectedBorderColor: "rgba(248, 81, 73, 0.8)",
      selectedRowBg: "rgba(248, 81, 73, 0.15)",
      emphasisBg: "rgba(248, 81, 73, 0.18)",
    };
  }

  return {
    containerBg: undefined,
    gutterBg: undefined,
    prefixColor: "transparent",
    prefix: " ",
    borderColor: "transparent",
    selectedBorderColor: "transparent",
    selectedRowBg: undefined,
    emphasisBg: undefined,
  };
}
