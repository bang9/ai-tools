import { useMemo } from "react";
import type { DiffHunk as DiffHunkType } from "../../types";
import { cn } from "../../lib/cn";
import {
  buildHighlightedBlocks,
  type HighlightedBlock,
  type HighlightedGroup,
  type HighlightedLine,
} from "./intraline";
import {
  buildConflictHighlightedGroups,
  type ConflictGroupType,
} from "./conflict-highlighting";

interface Props {
  hunk: DiffHunkType;
  isFirst: boolean;
  isConflicted?: boolean;
  selectedLines: Set<number>;
  onGutterClick: (lineIndex: number, shiftKey: boolean) => void;
  onGutterMouseDown: (lineIndex: number) => void;
  onGutterMouseEnter: (lineIndex: number, buttons: number) => void;
  onGutterMouseUp: () => void;
}

export default function DiffHunk({
  hunk,
  isFirst,
  isConflicted = false,
  selectedLines,
  onGutterClick,
  onGutterMouseDown,
  onGutterMouseEnter,
  onGutterMouseUp,
}: Props) {
  const highlightedBlocks = useMemo(
    () => (isConflicted ? [] : buildHighlightedBlocks(hunk.lines)),
    [hunk.lines, isConflicted],
  );
  const conflictGroups = useMemo(
    () => (isConflicted ? buildConflictHighlightedGroups(hunk.lines) : []),
    [hunk.lines, isConflicted],
  );

  return (
    <div className={cn({ "border-t border-border": !isFirst })}>
      {isConflicted
        ? conflictGroups.map((group, index) => (
            <LineGroupView
              key={lineGroupKey(group, index)}
              type={group.type}
              lines={group.lines}
              readOnly
              selectedLines={selectedLines}
              onGutterClick={onGutterClick}
              onGutterMouseDown={onGutterMouseDown}
              onGutterMouseEnter={onGutterMouseEnter}
              onGutterMouseUp={onGutterMouseUp}
            />
          ))
        : highlightedBlocks.map((block, index) =>
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

type RenderGroupType = HighlightedGroup["type"] | ConflictGroupType;
type RenderGroup = {
  type: RenderGroupType;
  lines: HighlightedLine[];
};

function blockKey(block: HighlightedBlock, fallbackIndex: number): string {
  if (block.kind === "paired") {
    return `paired-${block.remove.lines[0]?.line.index ?? fallbackIndex}`;
  }

  return `group-${block.group.lines[0]?.line.index ?? fallbackIndex}`;
}

function lineGroupKey(group: RenderGroup, fallbackIndex: number): string {
  return `${group.type}-${group.lines[0]?.line.index ?? fallbackIndex}`;
}

function LineGroupView({
  type,
  lines,
  readOnly = false,
  selectedLines,
  onGutterClick,
  onGutterMouseDown,
  onGutterMouseEnter,
  onGutterMouseUp,
}: {
  type: RenderGroupType;
  lines: HighlightedLine[];
  readOnly?: boolean;
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
        readOnly={readOnly}
        selectedLines={selectedLines}
        onGutterClick={onGutterClick}
        onGutterMouseDown={onGutterMouseDown}
        onGutterMouseEnter={onGutterMouseEnter}
        onGutterMouseUp={onGutterMouseUp}
      />
      <div className={cn("flex-1 overflow-x-auto overflow-y-hidden diff-line-content")}>
        <div className={cn("min-w-full w-max")}>
          <GroupCodeRows
            type={type}
            lines={lines}
            readOnly={readOnly}
            selectedLines={selectedLines}
          />
        </div>
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
        <div className={cn("min-w-full w-max")}>
          <GroupCodeRows type={remove.type} lines={remove.lines} selectedLines={selectedLines} />
          <GroupCodeRows type={add.type} lines={add.lines} selectedLines={selectedLines} />
        </div>
      </div>
    </div>
  );
}

function GroupGutterView({
  type,
  lines,
  readOnly = false,
  selectedLines,
  onGutterClick,
  onGutterMouseDown,
  onGutterMouseEnter,
  onGutterMouseUp,
}: {
  type: RenderGroupType;
  lines: HighlightedLine[];
  readOnly?: boolean;
  selectedLines: Set<number>;
  onGutterClick: (lineIndex: number, shiftKey: boolean) => void;
  onGutterMouseDown: (lineIndex: number) => void;
  onGutterMouseEnter: (lineIndex: number, buttons: number) => void;
  onGutterMouseUp: () => void;
}) {
  const style = getGroupStyle(type);
  const isSelectableType = type !== "context" && type !== "conflict-marker";

  return (
    <div
      className="shrink-0"
      style={{
        backgroundColor: style.gutterBg,
        borderLeft: `2px solid ${style.borderColor}`,
      }}
    >
        {lines.map((line) => {
          const isSelectable = isSelectableType && !readOnly;
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
  readOnly = false,
  selectedLines,
}: {
  type: RenderGroupType;
  lines: HighlightedLine[];
  readOnly?: boolean;
  selectedLines: Set<number>;
}) {
  const style = getGroupStyle(type);
  const isContext = type === "context";
  const isSelectableType = type !== "context" && type !== "conflict-marker";

  return (
    <div className={cn("min-w-full")} style={{ backgroundColor: style.containerBg }}>
      {lines.map((line) => {
        const isSelectable = isSelectableType && !readOnly;
        const isSelected = isSelectable && selectedLines.has(line.line.index);
        const rowStyle = {
          ...(style.textColor ? { color: style.textColor } : {}),
          ...(isSelected ? { backgroundColor: style.selectedRowBg } : {}),
        };

        return (
          <div
            key={line.line.index}
            className={cn("min-h-[20px] w-full leading-[20px] font-mono text-[12px] whitespace-pre pr-3", {
              "text-foreground/80": isContext,
            })}
            style={rowStyle}
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

function getGroupStyle(type: RenderGroupType) {
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
      textColor: undefined,
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
      textColor: undefined,
    };
  }

  if (type === "conflict-marker") {
    return {
      containerBg: "rgba(210, 153, 34, 0.12)",
      gutterBg: "rgba(210, 153, 34, 0.08)",
      prefixColor: "rgba(210, 153, 34, 0.95)",
      prefix: "!",
      borderColor: "rgba(210, 153, 34, 0.45)",
      selectedBorderColor: "transparent",
      selectedRowBg: undefined,
      emphasisBg: undefined,
      textColor: "rgba(255, 220, 140, 0.95)",
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
    textColor: undefined,
  };
}
