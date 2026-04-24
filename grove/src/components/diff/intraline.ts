import type { DiffLine as DiffLineType } from "../../types";

type GroupType = "add" | "remove" | "context";
type RawGroup = { type: GroupType; lines: DiffLineType[] };

export interface HighlightSegment {
  text: string;
  emphasis: boolean;
}

export interface HighlightedLine {
  line: DiffLineType;
  segments: HighlightSegment[];
}

export interface HighlightedGroup {
  type: GroupType;
  lines: HighlightedLine[];
}

export type HighlightedBlock =
  | {
      kind: "group";
      group: HighlightedGroup;
    }
  | {
      kind: "paired";
      remove: HighlightedGroup;
      add: HighlightedGroup;
    };

const TOKEN_SPLIT_RE = /(\s+|[()[\]{}.,;:+\-*/=!<>|&%^~?:]+)/g;
const MAX_TOKEN_DIFF_LINE_LENGTH = 300;
const MAX_TOKEN_COUNT = 80;

export function buildHighlightedBlocks(lines: DiffLineType[]): HighlightedBlock[] {
  const rawGroups = groupLines(lines);
  const blocks: HighlightedBlock[] = [];

  for (let index = 0; index < rawGroups.length; index += 1) {
    const current = rawGroups[index];
    const next = rawGroups[index + 1];

    if (current.type === "remove" && next?.type === "add") {
      const paired = buildPairedGroups(current.lines, next.lines);
      blocks.push({
        kind: "paired",
        remove: { type: "remove", lines: paired.remove },
        add: { type: "add", lines: paired.add },
      });
      index += 1;
      continue;
    }

    blocks.push({
      kind: "group",
      group: {
        type: current.type,
        lines: current.lines.map((line) => ({ line, segments: plainSegments(line.content) })),
      },
    });
  }

  return blocks;
}

export function buildHighlightedGroups(lines: DiffLineType[]): HighlightedGroup[] {
  return buildHighlightedBlocks(lines).flatMap((block) =>
    block.kind === "paired" ? [block.remove, block.add] : [block.group],
  );
}

export function buildLinePairHighlight(
  removeContent: string,
  addContent: string,
): { remove: HighlightSegment[]; add: HighlightSegment[] } | null {
  const removeParts = splitLineEnding(removeContent);
  const addParts = splitLineEnding(addContent);

  if (removeParts.body === addParts.body) {
    return null;
  }

  const fastPath = buildPrefixSuffixHighlight(removeParts.body, addParts.body);
  if (fastPath) {
    return {
      remove: appendLineEnding(fastPath.remove, removeParts.ending),
      add: appendLineEnding(fastPath.add, addParts.ending),
    };
  }

  const tokenPath = buildTokenHighlight(removeParts.body, addParts.body);
  if (tokenPath) {
    return {
      remove: appendLineEnding(tokenPath.remove, removeParts.ending),
      add: appendLineEnding(tokenPath.add, addParts.ending),
    };
  }

  return null;
}

function buildPairedGroups(removeLines: DiffLineType[], addLines: DiffLineType[]) {
  const highlightedRemove = removeLines.map((line) => ({
    line,
    segments: plainSegments(line.content),
  }));
  const highlightedAdd = addLines.map((line) => ({
    line,
    segments: plainSegments(line.content),
  }));

  const pairCount = Math.min(removeLines.length, addLines.length);
  for (let index = 0; index < pairCount; index += 1) {
    const highlight = buildLinePairHighlight(removeLines[index].content, addLines[index].content);
    if (!highlight) {
      continue;
    }
    highlightedRemove[index] = { line: removeLines[index], segments: highlight.remove };
    highlightedAdd[index] = { line: addLines[index], segments: highlight.add };
  }

  return {
    remove: highlightedRemove,
    add: highlightedAdd,
  };
}

function groupLines(lines: DiffLineType[]): RawGroup[] {
  const groups: RawGroup[] = [];

  for (const line of lines) {
    let type: GroupType = "context";
    if (line.type === "add") {
      type = "add";
    } else if (line.type === "remove") {
      type = "remove";
    }

    const last = groups[groups.length - 1];
    if (last && last.type === type) {
      last.lines.push(line);
      continue;
    }

    groups.push({ type, lines: [line] });
  }

  return groups;
}

function buildPrefixSuffixHighlight(
  removeBody: string,
  addBody: string,
): { remove: HighlightSegment[]; add: HighlightSegment[] } | null {
  const prefixLength = sharedPrefixLength(removeBody, addBody);
  const suffixLength = sharedSuffixLength(removeBody, addBody, prefixLength);
  const sharedLength = prefixLength + suffixLength;
  const maxLength = Math.max(removeBody.length, addBody.length);

  if (sharedLength === 0) {
    return null;
  }

  if (sharedLength < 3 && sharedLength / Math.max(maxLength, 1) <= 0.2) {
    return null;
  }

  return {
    remove: buildSegmentsFromSlices(removeBody, prefixLength, suffixLength),
    add: buildSegmentsFromSlices(addBody, prefixLength, suffixLength),
  };
}

function buildTokenHighlight(
  removeBody: string,
  addBody: string,
): { remove: HighlightSegment[]; add: HighlightSegment[] } | null {
  if (
    removeBody.length > MAX_TOKEN_DIFF_LINE_LENGTH ||
    addBody.length > MAX_TOKEN_DIFF_LINE_LENGTH
  ) {
    return null;
  }

  const removeTokens = tokenize(removeBody);
  const addTokens = tokenize(addBody);

  if (
    removeTokens.length === 0 ||
    addTokens.length === 0 ||
    removeTokens.length > MAX_TOKEN_COUNT ||
    addTokens.length > MAX_TOKEN_COUNT
  ) {
    return null;
  }

  const matches = longestCommonSubsequence(removeTokens, addTokens);
  if (matches.visibleChars < 3 || matches.pairs.length === 0) {
    return null;
  }

  return {
    remove: buildSegmentsFromTokens(removeTokens, new Set(matches.pairs.map(([index]) => index))),
    add: buildSegmentsFromTokens(addTokens, new Set(matches.pairs.map(([, index]) => index))),
  };
}

function longestCommonSubsequence(left: string[], right: string[]) {
  const matrix = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));

  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
      matrix[leftIndex][rightIndex] =
        left[leftIndex] === right[rightIndex]
          ? matrix[leftIndex + 1][rightIndex + 1] + 1
          : Math.max(matrix[leftIndex + 1][rightIndex], matrix[leftIndex][rightIndex + 1]);
    }
  }

  const pairs: Array<[number, number]> = [];
  let visibleChars = 0;
  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      pairs.push([leftIndex, rightIndex]);
      visibleChars += left[leftIndex].replace(/\s+/g, "").length;
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }

    if (matrix[leftIndex + 1][rightIndex] >= matrix[leftIndex][rightIndex + 1]) {
      leftIndex += 1;
    } else {
      rightIndex += 1;
    }
  }

  return { pairs, visibleChars };
}

function buildSegmentsFromTokens(tokens: string[], matchedIndices: Set<number>): HighlightSegment[] {
  const segments: HighlightSegment[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const emphasis = !matchedIndices.has(index);
    pushSegment(segments, token, emphasis);
  }

  return segments.length > 0 ? segments : plainSegments(tokens.join(""));
}

function buildSegmentsFromSlices(
  input: string,
  prefixLength: number,
  suffixLength: number,
): HighlightSegment[] {
  const segments: HighlightSegment[] = [];
  const suffixStart = input.length - suffixLength;

  pushSegment(segments, input.slice(0, prefixLength), false);
  pushSegment(segments, input.slice(prefixLength, suffixStart), true);
  pushSegment(segments, input.slice(suffixStart), false);

  return segments.length > 0 ? segments : plainSegments(input);
}

function appendLineEnding(segments: HighlightSegment[], ending: string): HighlightSegment[] {
  if (!ending) {
    return segments;
  }

  return [...segments, { text: ending, emphasis: false }];
}

function plainSegments(text: string): HighlightSegment[] {
  return [{ text, emphasis: false }];
}

function pushSegment(segments: HighlightSegment[], text: string, emphasis: boolean) {
  if (!text) {
    return;
  }

  const last = segments[segments.length - 1];
  if (last && last.emphasis === emphasis) {
    last.text += text;
    return;
  }

  segments.push({ text, emphasis });
}

function tokenize(input: string): string[] {
  return input.split(TOKEN_SPLIT_RE).filter((token) => token.length > 0);
}

function sharedPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;

  while (index < limit && left[index] === right[index]) {
    index += 1;
  }

  return index;
}

function sharedSuffixLength(left: string, right: string, prefixLength: number): number {
  const maxSuffix = Math.min(left.length - prefixLength, right.length - prefixLength);
  let index = 0;

  while (
    index < maxSuffix &&
    left[left.length - 1 - index] === right[right.length - 1 - index]
  ) {
    index += 1;
  }

  return index;
}

function splitLineEnding(content: string): { body: string; ending: string } {
  const match = content.match(/(\r?\n)$/);
  if (!match || match.index == null) {
    return { body: content, ending: "" };
  }

  return {
    body: content.slice(0, match.index),
    ending: match[0],
  };
}
