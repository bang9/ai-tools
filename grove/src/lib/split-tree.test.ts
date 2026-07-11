import { beforeEach, describe, expect, it } from "vitest";
import type { SplitNode } from "../types";
import {
  assignPtyIds,
  collectLeafPaneIds,
  countLeaves,
  findFirstLeaf,
  normalizeSplitTree,
  removeNode,
  setSizesAtPath,
  setLeafLabel,
  splitNode,
  toLayoutTemplate,
} from "./split-tree";

let nextGeneratedId = 0;

function generatedId(prefix: string): string {
  nextGeneratedId += 1;
  return `${prefix}-${nextGeneratedId}`;
}

const leaf = (
  ptyId?: string,
  id = ptyId ? `leaf-${ptyId}` : generatedId("leaf"),
  label?: string,
): SplitNode => ({
  id,
  type: "leaf",
  ptyId,
  ...(label ? { label } : {}),
});

const hSplit = (
  children: SplitNode[],
  sizes?: number[],
  id = generatedId("horizontal"),
): SplitNode => ({
  id,
  type: "horizontal",
  children,
  sizes,
});

const vSplit = (
  children: SplitNode[],
  sizes?: number[],
  id = generatedId("vertical"),
): SplitNode => ({
  id,
  type: "vertical",
  children,
  sizes,
});

function expectRatios(actual: number[] | undefined, expected: number[]) {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((value, index) => {
    expect(actual![index]).toBeCloseTo(value);
  });
}

function idFactory(...ids: string[]) {
  let index = 0;
  return () => {
    const id = ids[index];
    index += 1;
    return id ?? `generated-${index}`;
  };
}

beforeEach(() => {
  nextGeneratedId = 0;
});

// ── normalizeSplitTree ──

describe("normalizeSplitTree", () => {
  it("adds missing ids and canonicalizes persisted sizes", () => {
    const result = normalizeSplitTree(
      {
        type: "horizontal",
        sizes: [40, 60],
        children: [
          { type: "leaf" },
          {
            id: "branch-existing",
            type: "vertical",
            sizes: [9, 1, 1],
            children: [{ type: "leaf" }, { id: "leaf-existing", type: "leaf" }],
          },
        ],
      },
      idFactory("root", "leaf-a", "leaf-b"),
    );

    expect(result).toEqual({
      id: "root",
      type: "horizontal",
      sizes: [0.4, 0.6],
      children: [
        { id: "leaf-a", type: "leaf", ptyId: undefined },
        {
          id: "branch-existing",
          type: "vertical",
          sizes: [0.5, 0.5],
          children: [
            { id: "leaf-b", type: "leaf", ptyId: undefined },
            { id: "leaf-existing", type: "leaf", ptyId: undefined },
          ],
        },
      ],
    });
  });

  it("falls back to a leaf when persisted type is invalid", () => {
    const result = normalizeSplitTree(
      { id: "legacy", type: undefined, ptyId: "pty-1" },
      idFactory("unused"),
    );

    expect(result).toEqual({ id: "legacy", type: "leaf", ptyId: "pty-1" });
  });

  it("preserves trimmed pane labels on leaves", () => {
    const result = normalizeSplitTree(
      { id: "leaf-1", type: "leaf", ptyId: "pty-1", label: "  build api  " },
      idFactory("unused"),
    );

    expect(result).toEqual({
      id: "leaf-1",
      type: "leaf",
      ptyId: "pty-1",
      label: "build api",
    });
  });
});

// ── toLayoutTemplate ──

describe("toLayoutTemplate", () => {
  it("strips ptyId from a single leaf while keeping its stable id", () => {
    const result = toLayoutTemplate(leaf("pty-1", "leaf-1"));
    expect(result).toEqual({ id: "leaf-1", type: "leaf" });
    expect(result.ptyId).toBeUndefined();
  });

  it("keeps pane labels when stripping runtime pty ids", () => {
    const result = toLayoutTemplate(leaf("pty-1", "leaf-1", "tests"));

    expect(result).toEqual({ id: "leaf-1", type: "leaf", label: "tests" });
    expect(result.ptyId).toBeUndefined();
  });

  it("returns bare leaf for leaf without ptyId", () => {
    expect(toLayoutTemplate(leaf(undefined, "leaf-1"))).toEqual({
      id: "leaf-1",
      type: "leaf",
    });
  });

  it("preserves structure and canonical 0-1 ratios for persistence", () => {
    const tree = hSplit([leaf("a", "leaf-a"), leaf("b", "leaf-b")], [400, 600], "root");
    const result = toLayoutTemplate(tree);

    expect(result).toEqual({
      id: "root",
      type: "horizontal",
      sizes: [0.4, 0.6],
      children: [
        { id: "leaf-a", type: "leaf" },
        { id: "leaf-b", type: "leaf" },
      ],
    });
  });

  it("keeps branch ids stable through nested serialization", () => {
    const tree = vSplit(
      [
        leaf("a", "leaf-a"),
        hSplit([leaf("b", "leaf-b"), leaf("c", "leaf-c")], [0.3, 0.7], "branch-b"),
      ],
      [0.25, 0.75],
      "root",
    );

    expect(toLayoutTemplate(tree)).toEqual({
      id: "root",
      type: "vertical",
      sizes: [0.25, 0.75],
      children: [
        { id: "leaf-a", type: "leaf" },
        {
          id: "branch-b",
          type: "horizontal",
          sizes: [0.3, 0.7],
          children: [
            { id: "leaf-b", type: "leaf" },
            { id: "leaf-c", type: "leaf" },
          ],
        },
      ],
    });
  });
});

// ── countLeaves ──

describe("countLeaves", () => {
  it("counts a single leaf as 1", () => {
    expect(countLeaves(leaf("x", "leaf-x"))).toBe(1);
  });

  it("counts two children in a flat split", () => {
    expect(countLeaves(hSplit([leaf("a", "leaf-a"), leaf("b", "leaf-b")], undefined, "root"))).toBe(2);
  });

  it("counts leaves in a nested tree", () => {
    const tree = vSplit(
      [
        leaf("a", "leaf-a"),
        hSplit([leaf("b", "leaf-b"), leaf("c", "leaf-c"), leaf("d", "leaf-d")], undefined, "branch"),
      ],
      undefined,
      "root",
    );
    expect(countLeaves(tree)).toBe(4);
  });

  it("counts a deeply nested single-leaf branch as 1", () => {
    const tree: SplitNode = {
      id: "root",
      type: "horizontal",
      children: [{ id: "nested", type: "vertical", children: [leaf("only", "leaf-only")] }],
    };
    expect(countLeaves(tree)).toBe(1);
  });

  it("returns 0 for a branch with no children", () => {
    const tree: SplitNode = { id: "root", type: "horizontal", children: [] };
    expect(countLeaves(tree)).toBe(0);
  });
});

// ── assignPtyIds ──

describe("assignPtyIds", () => {
  it("assigns a single id to a single leaf without changing its stable id", () => {
    const ids = ["pty-1"];
    const result = assignPtyIds(leaf(undefined, "leaf-1"), ids);
    expect(result).toEqual({ id: "leaf-1", type: "leaf", ptyId: "pty-1" });
    expect(ids).toEqual([]);
  });

  it("preserves labels when assigning runtime pty ids", () => {
    const ids = ["pty-1"];
    const result = assignPtyIds(leaf(undefined, "leaf-1", "docs"), ids);

    expect(result).toEqual({
      id: "leaf-1",
      type: "leaf",
      ptyId: "pty-1",
      label: "docs",
    });
  });

  it("assigns ids to leaves in left-to-right order", () => {
    const template = hSplit([leaf(undefined, "leaf-a"), leaf(undefined, "leaf-b")], undefined, "root");
    const ids = ["a", "b"];
    const result = assignPtyIds(template, ids);

    expect(result.children![0]).toEqual({ id: "leaf-a", type: "leaf", ptyId: "a" });
    expect(result.children![1]).toEqual({ id: "leaf-b", type: "leaf", ptyId: "b" });
  });

  it("preserves nested branch ids and saved ratios on restore", () => {
    const template = vSplit(
      [
        leaf(undefined, "leaf-x"),
        hSplit([leaf(undefined, "leaf-y"), leaf(undefined, "leaf-z")], [0.8, 0.2], "branch"),
      ],
      [0.322, 0.678],
      "root",
    );
    const ids = ["x", "y", "z"];
    const result = assignPtyIds(template, ids);

    expect(result.id).toBe("root");
    expect(result.children![1].id).toBe("branch");
    expect(result.sizes).toEqual([0.322, 0.678]);
    expect(result.children![1].sizes).toEqual([0.8, 0.2]);
    expect(result.children![0].ptyId).toBe("x");
    expect(result.children![1].children![0].ptyId).toBe("y");
    expect(result.children![1].children![1].ptyId).toBe("z");
  });

  it("assigns undefined when ids array is exhausted", () => {
    const template = hSplit([leaf(undefined, "leaf-a"), leaf(undefined, "leaf-b")], undefined, "root");
    const ids = ["only-one"];
    const result = assignPtyIds(template, ids);

    expect(result.children![0].ptyId).toBe("only-one");
    expect(result.children![1].ptyId).toBeUndefined();
  });
});

// ── splitNode ──

describe("splitNode", () => {
  it("wraps the target leaf in a new branch while preserving the existing leaf id", () => {
    const result = splitNode(leaf("a", "leaf-a"), "a", "horizontal", {
      branchId: "branch-new",
      leafId: "leaf-b",
      ptyId: "b",
    });

    expect(result).toEqual({
      id: "branch-new",
      type: "horizontal",
      sizes: [0.5, 0.5],
      children: [
        { id: "leaf-a", type: "leaf", ptyId: "a" },
        { id: "leaf-b", type: "leaf", ptyId: "b" },
      ],
    });
  });

  it("returns the same reference if the target is not found", () => {
    const tree = hSplit([leaf("a", "leaf-a"), leaf("b", "leaf-b")], undefined, "root");
    const result = splitNode(tree, "missing", "vertical", {
      branchId: "branch-new",
      leafId: "leaf-c",
      ptyId: "c",
    });

    expect(result).toBe(tree);
  });

  it("preserves unrelated branch references and parent ratios when splitting deeply", () => {
    const left = leaf("a", "leaf-a");
    const right = hSplit([leaf("b", "leaf-b"), leaf("c", "leaf-c")], [0.4, 0.6], "branch-right");
    const tree = vSplit([left, right], [0.25, 0.75], "root");

    const result = splitNode(tree, "c", "horizontal", {
      branchId: "branch-new",
      leafId: "leaf-d",
      ptyId: "d",
    });

    expect(result.children![0]).toBe(left);
    expect(result.sizes).toEqual([0.25, 0.75]);
    expect(result.children![1].id).toBe("branch-right");
    expect(result.children![1].children![1]).toEqual(
      hSplit([leaf("c", "leaf-c"), leaf("d", "leaf-d")], [0.5, 0.5], "branch-new"),
    );
  });
});

// ── setLeafLabel ──

describe("setLeafLabel", () => {
  it("sets a trimmed label on the matching leaf", () => {
    const result = setLeafLabel(leaf("a", "leaf-a"), "leaf-a", "  tests  ");

    expect(result).toEqual(leaf("a", "leaf-a", "tests"));
  });

  it("caps labels at 20 characters", () => {
    const result = setLeafLabel(leaf("a", "leaf-a"), "leaf-a", "1234567890123456789012345");

    expect(result).toEqual(leaf("a", "leaf-a", "12345678901234567890"));
  });

  it("clears a label by removing the field", () => {
    const result = setLeafLabel(leaf("a", "leaf-a", "tests"), "leaf-a", "");

    expect(result).toEqual(leaf("a", "leaf-a"));
  });

  it("updates a nested leaf without changing unrelated branches", () => {
    const left = leaf("a", "leaf-a");
    const right = hSplit([leaf("b", "leaf-b"), leaf("c", "leaf-c")], [0.4, 0.6], "branch-right");
    const tree = vSplit([left, right], [0.25, 0.75], "root");

    const result = setLeafLabel(tree, "leaf-c", "review");

    expect(result.children![0]).toBe(left);
    expect(result.children![1].children![0]).toBe(right.children![0]);
    expect(result.children![1].children![1]).toEqual(leaf("c", "leaf-c", "review"));
  });

  it("returns the same reference when the label does not change", () => {
    const node = leaf("a", "leaf-a", "tests");

    expect(setLeafLabel(node, "leaf-a", "tests")).toBe(node);
  });
});

// ── removeNode ──

describe("removeNode", () => {
  it("returns null when removing the only leaf", () => {
    expect(removeNode(leaf("a", "leaf-a"), "a")).toBeNull();
  });

  it("keeps a leaf that does not match", () => {
    const node = leaf("a", "leaf-a");
    expect(removeNode(node, "b")).toBe(node);
  });

  it("collapses a two-child split back to the remaining child identity", () => {
    const remaining = leaf("b", "leaf-b");
    const tree = hSplit([leaf("a", "leaf-a"), remaining], [0.7, 0.3], "root");
    const result = removeNode(tree, "a");

    expect(result).toBe(remaining);
  });

  it("rebalances ratios when removing one child from a larger split", () => {
    const tree = hSplit(
      [leaf("a", "leaf-a"), leaf("b", "leaf-b"), leaf("c", "leaf-c")],
      [0.2, 0.3, 0.5],
      "root",
    );
    const result = removeNode(tree, "b");

    expect(result?.id).toBe("root");
    expect(result?.type).toBe("horizontal");
    expect(result?.children).toEqual([leaf("a", "leaf-a"), leaf("c", "leaf-c")]);
    expectRatios(result?.sizes, [2 / 7, 5 / 7]);
  });

  it("preserves parent ratios when nested removal only collapses a descendant", () => {
    const tree = hSplit(
      [
        vSplit([leaf("a", "leaf-a"), leaf("b", "leaf-b")], [0.25, 0.75], "branch-left"),
        leaf("c", "leaf-c"),
      ],
      [0.6, 0.4],
      "root",
    );
    const result = removeNode(tree, "b");

    expect(result).toEqual(
      hSplit([leaf("a", "leaf-a"), leaf("c", "leaf-c")], [0.6, 0.4], "root"),
    );
  });

  it("returns null when all leaves are removed", () => {
    const tree = hSplit([leaf("a", "leaf-a")], undefined, "root");
    expect(removeNode(tree, "a")).toBeNull();
  });

  it("returns node unchanged for branch with no children field", () => {
    const node: SplitNode = { id: "root", type: "horizontal" };
    expect(removeNode(node, "a")).toBe(node);
  });
});

// ── findFirstLeaf ──

describe("findFirstLeaf", () => {
  it("returns ptyId of a single leaf", () => {
    expect(findFirstLeaf(leaf("x", "leaf-x"))).toBe("x");
  });

  it("returns null for a leaf without ptyId", () => {
    expect(findFirstLeaf(leaf(undefined, "leaf-x"))).toBeNull();
  });

  it("finds the leftmost leaf in a flat split", () => {
    expect(findFirstLeaf(hSplit([leaf("a", "leaf-a"), leaf("b", "leaf-b")], undefined, "root"))).toBe("a");
  });

  it("finds the deepest-left leaf in a nested tree", () => {
    const tree = vSplit(
      [
        hSplit([leaf("deep-left", "leaf-left"), leaf("x", "leaf-x")], undefined, "branch"),
        leaf("y", "leaf-y"),
      ],
      undefined,
      "root",
    );
    expect(findFirstLeaf(tree)).toBe("deep-left");
  });

  it("skips leaves without ptyId to find the first usable pane", () => {
    const tree = hSplit([leaf(undefined, "leaf-empty"), leaf("found", "leaf-found")], undefined, "root");
    expect(findFirstLeaf(tree)).toBe("found");
  });

  it("returns null when no leaf has a ptyId", () => {
    const tree = hSplit([leaf(undefined, "leaf-a"), leaf(undefined, "leaf-b")], undefined, "root");
    expect(findFirstLeaf(tree)).toBeNull();
  });
});

// ── setSizesAtPath ──

describe("setSizesAtPath", () => {
  it("sets sizes at root (empty path)", () => {
    const tree = hSplit([leaf("a", "leaf-a"), leaf("b", "leaf-b")], undefined, "root");
    const result = setSizesAtPath(tree, [], [0.3, 0.7]);

    expect(result.sizes).toEqual([0.3, 0.7]);
    expect(result.children).toBe(tree.children);
  });

  it("sets sizes at a nested child path", () => {
    const inner = hSplit([leaf("a", "leaf-a"), leaf("b", "leaf-b")], undefined, "branch");
    const tree = vSplit([inner, leaf("c", "leaf-c")], undefined, "root");
    const result = setSizesAtPath(tree, [0], [0.25, 0.75]);

    expect(result.children![0].sizes).toEqual([0.25, 0.75]);
    expect(result.children![1]).toBe(tree.children![1]);
  });

  it("sets sizes two levels deep", () => {
    const deepInner = vSplit([leaf("x", "leaf-x"), leaf("y", "leaf-y")], undefined, "branch-inner");
    const tree = hSplit([vSplit([deepInner, leaf("z", "leaf-z")], undefined, "branch"), leaf("w", "leaf-w")], undefined, "root");
    const result = setSizesAtPath(tree, [0, 0], [0.1, 0.9]);

    expect(result.children![0].children![0].sizes).toEqual([0.1, 0.9]);
  });

  it("returns node unchanged if path hits a leaf", () => {
    const tree = hSplit([leaf("a", "leaf-a"), leaf("b", "leaf-b")], undefined, "root");
    const result = setSizesAtPath(tree, [0, 0], [0.5, 0.5]);

    expect(result.children![0]).toBe(tree.children![0]);
  });

  it("preserves other branches when setting sizes", () => {
    const tree = hSplit(
      [
        vSplit([leaf("a", "leaf-a"), leaf("b", "leaf-b")], [0.6, 0.4], "branch-left"),
        vSplit([leaf("c", "leaf-c"), leaf("d", "leaf-d")], [0.5, 0.5], "branch-right"),
      ],
      undefined,
      "root",
    );
    const result = setSizesAtPath(tree, [0], [0.2, 0.8]);

    expect(result.children![0].sizes).toEqual([0.2, 0.8]);
    expect(result.children![1]).toBe(tree.children![1]);
    expect(result.children![1].sizes).toEqual([0.5, 0.5]);
  });
});

describe("collectLeafPaneIds", () => {
  it("returns the node id for a single leaf", () => {
    expect(collectLeafPaneIds(leaf("a", "leaf-a"))).toEqual(["leaf-a"]);
  });

  it("collects every leaf id under a nested split, ignoring branch ids", () => {
    const tree = hSplit(
      [
        vSplit([leaf("a", "leaf-a"), leaf("b", "leaf-b")], [0.5, 0.5], "branch-left"),
        leaf("c", "leaf-c"),
      ],
      undefined,
      "root",
    );

    expect(collectLeafPaneIds(tree)).toEqual(["leaf-a", "leaf-b", "leaf-c"]);
  });

  it("scopes to the subtree it is given, not the whole tree", () => {
    const left = vSplit([leaf("a", "leaf-a"), leaf("b", "leaf-b")], [0.5, 0.5], "branch-left");
    const tree = hSplit([left, leaf("c", "leaf-c")], undefined, "root");

    expect(collectLeafPaneIds(tree.children![0])).toEqual(["leaf-a", "leaf-b"]);
  });
});
