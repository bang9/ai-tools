import { describe, expect, it } from "vitest";
import {
  buildHighlightedBlocks,
  buildHighlightedGroups,
  buildLinePairHighlight,
} from "./intraline";

describe("buildLinePairHighlight", () => {
  it("highlights changed suffix with the fast prefix path", () => {
    const result = buildLinePairHighlight(
      "const total = count + 1\n",
      "const total = count + 2\n",
    );

    expect(result).toEqual({
      remove: [
        { text: "const total = count + ", emphasis: false },
        { text: "1", emphasis: true },
        { text: "\n", emphasis: false },
      ],
      add: [
        { text: "const total = count + ", emphasis: false },
        { text: "2", emphasis: true },
        { text: "\n", emphasis: false },
      ],
    });
  });

  it("falls back to token diff when shared text is in the middle", () => {
    const result = buildLinePairHighlight(
      "const total = count + 1\n",
      "let total = count + 2\n",
    );

    expect(result).toEqual({
      remove: [
        { text: "const", emphasis: true },
        { text: " total = count + ", emphasis: false },
        { text: "1", emphasis: true },
        { text: "\n", emphasis: false },
      ],
      add: [
        { text: "let", emphasis: true },
        { text: " total = count + ", emphasis: false },
        { text: "2", emphasis: true },
        { text: "\n", emphasis: false },
      ],
    });
  });

  it("skips intra-line highlight for unrelated lines", () => {
    expect(buildLinePairHighlight("alpha\n", "beta\n")).toBeNull();
  });
});

describe("buildHighlightedGroups", () => {
  it("returns a paired block for adjacent remove/add groups", () => {
    const blocks = buildHighlightedBlocks([
      {
        type: "remove",
        content: "const total = count + 1\n",
        oldLineNumber: 4,
        index: 12,
      },
      {
        type: "add",
        content: "const total = count + 2\n",
        newLineNumber: 4,
        index: 13,
      },
      {
        type: "context",
        content: "stable line\n",
        oldLineNumber: 5,
        newLineNumber: 5,
        index: 14,
      },
    ]);

    expect(blocks).toMatchObject([
      {
        kind: "paired",
        remove: {
          type: "remove",
          lines: [
            {
              line: { index: 12 },
              segments: [
                { text: "const total = count + ", emphasis: false },
                { text: "1", emphasis: true },
                { text: "\n", emphasis: false },
              ],
            },
          ],
        },
        add: {
          type: "add",
          lines: [
            {
              line: { index: 13 },
              segments: [
                { text: "const total = count + ", emphasis: false },
                { text: "2", emphasis: true },
                { text: "\n", emphasis: false },
              ],
            },
          ],
        },
      },
      {
        kind: "group",
        group: {
          type: "context",
          lines: [{ line: { index: 14 } }],
        },
      },
    ]);
  });

  it("keeps unpaired remove groups plain and preserves line indices", () => {
    const groups = buildHighlightedGroups([
      {
        type: "remove",
        content: "line to delete\n",
        oldLineNumber: 4,
        index: 12,
      },
      {
        type: "context",
        content: "stable line\n",
        oldLineNumber: 5,
        newLineNumber: 4,
        index: 13,
      },
    ]);

    expect(groups).toEqual([
      {
        type: "remove",
        lines: [
          {
            line: {
              type: "remove",
              content: "line to delete\n",
              oldLineNumber: 4,
              index: 12,
            },
            segments: [{ text: "line to delete\n", emphasis: false }],
          },
        ],
      },
      {
        type: "context",
        lines: [
          {
            line: {
              type: "context",
              content: "stable line\n",
              oldLineNumber: 5,
              newLineNumber: 4,
              index: 13,
            },
            segments: [{ text: "stable line\n", emphasis: false }],
          },
        ],
      },
    ]);
  });
});
