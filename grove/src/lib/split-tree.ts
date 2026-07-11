import type { SplitNode } from "../types";

export const TERMINAL_PANE_LABEL_MAX_LENGTH = 20;

interface PersistedSplitNode {
  id?: string;
  type?: SplitNode["type"];
  ptyId?: string;
  label?: string;
  children?: PersistedSplitNode[];
  sizes?: number[];
}

interface SplitInsertion {
  branchId: string;
  leafId: string;
  ptyId: string;
}

function normalizeRatios(sizes: number[]): number[] | undefined {
  const clamped = sizes.map((size) => Math.max(size, 0));
  const total = clamped.reduce((sum, size) => sum + size, 0);
  return total > 0 ? clamped.map((size) => size / total) : undefined;
}

function evenRatios(count: number): number[] | undefined {
  return count > 1 ? Array.from({ length: count }, () => 1 / count) : undefined;
}

function normalizeBranchSizes(sizes: number[] | undefined, childCount: number): number[] | undefined {
  if (childCount <= 1) return undefined;
  if (!sizes || sizes.length !== childCount) {
    return evenRatios(childCount);
  }
  return normalizeRatios(sizes) ?? evenRatios(childCount);
}

function normalizePaneLabel(label: string | undefined): string | undefined {
  const trimmed = label?.trim().slice(0, TERMINAL_PANE_LABEL_MAX_LENGTH);
  return trimmed ? trimmed : undefined;
}

function rebalanceBranchSizes(
  sizes: number[] | undefined,
  retainedIndices: number[],
): number[] | undefined {
  if (retainedIndices.length <= 1) return undefined;
  if (!sizes || sizes.length === 0) {
    return evenRatios(retainedIndices.length);
  }

  const retainedSizes = retainedIndices.map((index) => sizes[index] ?? 0);
  return normalizeRatios(retainedSizes) ?? evenRatios(retainedIndices.length);
}

export function normalizeSplitTree(node: PersistedSplitNode, createId: () => string): SplitNode {
  const id = node.id ?? createId();

  if (node.type === "leaf" || (node.type !== "horizontal" && node.type !== "vertical")) {
    const label = normalizePaneLabel(node.label);
    return {
      id,
      type: "leaf",
      ptyId: node.ptyId,
      ...(label ? { label } : {}),
    };
  }

  const children = (node.children ?? []).map((child) => normalizeSplitTree(child, createId));

  return {
    id,
    type: node.type,
    children,
    sizes: normalizeBranchSizes(node.sizes, children.length),
  };
}

/** Strip ptyIds from a SplitNode tree, keeping stable ids + canonical ratios. */
export function toLayoutTemplate(node: SplitNode): SplitNode {
  if (node.type === "leaf") {
    const label = normalizePaneLabel(node.label);
    return label ? { id: node.id, type: "leaf", label } : { id: node.id, type: "leaf" };
  }

  const children = (node.children ?? []).map(toLayoutTemplate);
  return {
    id: node.id,
    type: node.type,
    sizes: normalizeBranchSizes(node.sizes, children.length),
    children,
  };
}

/** Count leaf nodes in a layout. */
export function countLeaves(node: SplitNode): number {
  if (node.type === "leaf") return 1;
  return (node.children ?? []).reduce((sum, c) => sum + countLeaves(c), 0);
}

/** Assign ptyIds from an array into a layout template's leaf nodes. */
export function assignPtyIds(node: SplitNode, ids: string[]): SplitNode {
  if (node.type === "leaf") {
    const label = normalizePaneLabel(node.label);
    return {
      id: node.id,
      type: "leaf",
      ptyId: ids.shift(),
      ...(label ? { label } : {}),
    };
  }

  const children = (node.children ?? []).map((child) => assignPtyIds(child, ids));
  return {
    id: node.id,
    type: node.type,
    sizes: normalizeBranchSizes(node.sizes, children.length),
    children,
  };
}

export function setLeafLabel(
  node: SplitNode,
  paneId: string,
  label: string | undefined,
): SplitNode {
  if (node.type === "leaf") {
    if (node.id !== paneId) return node;
    const normalizedLabel = normalizePaneLabel(label);
    if (node.label === normalizedLabel) return node;
    if (normalizedLabel) {
      return { ...node, label: normalizedLabel };
    }
    const next = { ...node };
    delete next.label;
    return next;
  }

  if (!node.children) return node;
  const children = node.children.map((child) => setLeafLabel(child, paneId, label));
  if (children.every((child, index) => child === node.children![index])) {
    return node;
  }
  return { ...node, children };
}

export function splitNode(
  node: SplitNode,
  targetPtyId: string,
  direction: "horizontal" | "vertical",
  insertion: SplitInsertion,
): SplitNode {
  if (node.type === "leaf" && node.ptyId === targetPtyId) {
    return {
      id: insertion.branchId,
      type: direction,
      sizes: [0.5, 0.5],
      children: [
        { ...node },
        { id: insertion.leafId, type: "leaf", ptyId: insertion.ptyId },
      ],
    };
  }
  if (node.children) {
    const newChildren = node.children.map((child) =>
      splitNode(child, targetPtyId, direction, insertion),
    );
    if (newChildren.some((c, i) => c !== node.children![i])) {
      return { ...node, children: newChildren };
    }
  }
  return node;
}

export function removeNode(node: SplitNode, targetPtyId: string): SplitNode | null {
  if (node.type === "leaf") {
    return node.ptyId === targetPtyId ? null : node;
  }
  if (!node.children) return node;

  const retainedIndices: number[] = [];
  let changed = false;
  const filtered = node.children
    .map((child, index) => {
      const nextChild = removeNode(child, targetPtyId);
      if (nextChild !== child) {
        changed = true;
      }
      if (nextChild) {
        retainedIndices.push(index);
      }
      return nextChild;
    })
    .filter((child): child is SplitNode => child !== null);

  if (!changed) return node;

  if (filtered.length === 0) return null;
  if (filtered.length === 1) return filtered[0];

  if (filtered.length === node.children.length) {
    return { ...node, children: filtered };
  }

  return {
    ...node,
    children: filtered,
    sizes: rebalanceBranchSizes(node.sizes, retainedIndices),
  };
}

/** Set sizes at a specific path in the tree. nodePath = [childIndex, childIndex, ...] */
export function setSizesAtPath(node: SplitNode, path: number[], sizes: number[]): SplitNode {
  if (path.length === 0) {
    return { ...node, sizes };
  }
  if (!node.children) return node;
  const [head, ...rest] = path;
  const newChildren = node.children.map((child, i) =>
    i === head ? setSizesAtPath(child, rest, sizes) : child,
  );
  return { ...node, children: newChildren };
}

/** Collect the ids of every leaf node under `node` (including `node` itself if it is a leaf). */
export function collectLeafPaneIds(node: SplitNode): string[] {
  const ids: string[] = [];
  const walk = (n: SplitNode) => {
    if (n.type === "leaf") {
      ids.push(n.id);
    } else {
      n.children?.forEach(walk);
    }
  };
  walk(node);
  return ids;
}

export function findFirstLeaf(node: SplitNode): string | null {
  if (node.type === "leaf") return node.ptyId ?? null;
  if (node.children) {
    for (const child of node.children) {
      const id = findFirstLeaf(child);
      if (id) return id;
    }
  }
  return null;
}
