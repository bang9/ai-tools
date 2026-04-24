import type { DiffLine } from "../../types";
import type { HighlightedLine } from "./intraline";

export type ConflictGroupType = "add" | "remove" | "context" | "conflict-marker";

export interface ConflictHighlightedGroup {
  type: ConflictGroupType;
  lines: HighlightedLine[];
}

export function buildConflictHighlightedGroups(lines: DiffLine[]): ConflictHighlightedGroup[] {
  const groups: ConflictHighlightedGroup[] = [];
  let currentType: ConflictGroupType = "context";

  for (const line of lines) {
    const markerType = getConflictMarkerType(line.content);
    if (markerType === "start") {
      pushConflictLine(groups, "conflict-marker", line);
      currentType = "remove";
      continue;
    }
    if (markerType === "base") {
      pushConflictLine(groups, "conflict-marker", line);
      currentType = "context";
      continue;
    }
    if (markerType === "separator") {
      pushConflictLine(groups, "conflict-marker", line);
      currentType = "add";
      continue;
    }
    if (markerType === "end") {
      pushConflictLine(groups, "conflict-marker", line);
      currentType = "context";
      continue;
    }

    pushConflictLine(groups, currentType, line);
  }

  return groups;
}

function getConflictMarkerType(content: string): "start" | "base" | "separator" | "end" | null {
  if (content.startsWith("<<<<<<<")) return "start";
  if (content.startsWith("|||||||")) return "base";
  if (content.startsWith("=======")) return "separator";
  if (content.startsWith(">>>>>>>")) return "end";
  return null;
}

function pushConflictLine(
  groups: ConflictHighlightedGroup[],
  type: ConflictGroupType,
  line: DiffLine,
) {
  const highlighted = {
    line,
    segments: [{ text: line.content, emphasis: false }],
  };
  const current = groups[groups.length - 1];
  if (current?.type === type) {
    current.lines.push(highlighted);
    return;
  }

  groups.push({ type, lines: [highlighted] });
}
