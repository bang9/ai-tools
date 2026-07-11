import type { SplitNode, TerminalTab, WorktreeTerminalSession } from "../types";
import type {
  SaveTerminalSessionSnapshotRequest,
  TerminalPaneSnapshot,
  TerminalRestoreCwdSource,
  TerminalSessionSnapshot,
} from "./platform";

export interface TerminalPaneEntry {
  paneId: string;
  ptyId?: string;
}

export interface TerminalRestorePlanEntry {
  paneId: string;
  launchCwd: string;
  lastKnownCwd: string | null;
  restoreCwd: string;
  restoreCwdSource: TerminalRestoreCwdSource | "fallback";
  scrollback: string;
  scrollbackTruncated: boolean;
}

const paneEntryCache = new WeakMap<SplitNode, TerminalPaneEntry[]>();

function findPaneSnapshot(
  snapshot: TerminalSessionSnapshot | null,
  paneId: string,
): TerminalPaneSnapshot | undefined {
  return snapshot?.panes.find((pane) => pane.paneId === paneId);
}

export function collectTerminalPanes(node: SplitNode): TerminalPaneEntry[] {
  const cached = paneEntryCache.get(node);
  if (cached) {
    return cached;
  }

  if (node.type === "leaf") {
    const panes = [{ paneId: node.id, ptyId: node.ptyId }];
    paneEntryCache.set(node, panes);
    return panes;
  }

  const panes: TerminalPaneEntry[] = [];
  for (const child of node.children ?? []) {
    panes.push(...collectTerminalPanes(child));
  }
  paneEntryCache.set(node, panes);
  return panes;
}

export function findFirstTerminalPane(node: SplitNode): TerminalPaneEntry | null {
  return collectTerminalPanes(node)[0] ?? null;
}

export function findTerminalPaneByPaneId(
  node: SplitNode,
  paneId: string,
): TerminalPaneEntry | null {
  return collectTerminalPanes(node).find((pane) => pane.paneId === paneId) ?? null;
}

export function findTerminalPaneByPtyId(node: SplitNode, ptyId: string): TerminalPaneEntry | null {
  return collectTerminalPanes(node).find((pane) => pane.ptyId === ptyId) ?? null;
}

const sessionPaneCache = new WeakMap<WorktreeTerminalSession, TerminalPaneEntry[]>();

/** All panes of a worktree session, flattened across its terminal tabs. */
export function collectSessionPanes(
  session: WorktreeTerminalSession | undefined,
): TerminalPaneEntry[] {
  if (!session) {
    return [];
  }

  const cached = sessionPaneCache.get(session);
  if (cached) {
    return cached;
  }

  const panes: TerminalPaneEntry[] = [];
  for (const tab of session.tabs) {
    panes.push(...collectTerminalPanes(tab.node));
  }
  sessionPaneCache.set(session, panes);
  return panes;
}

export function findActiveTab(session: WorktreeTerminalSession | undefined): TerminalTab | null {
  if (!session) {
    return null;
  }
  return session.tabs.find((tab) => tab.id === session.activeTabId) ?? session.tabs[0] ?? null;
}

export function findTabByPtyId(
  session: WorktreeTerminalSession | undefined,
  ptyId: string,
): TerminalTab | null {
  if (!session) {
    return null;
  }
  return (
    session.tabs.find((tab) =>
      collectTerminalPanes(tab.node).some((pane) => pane.ptyId === ptyId),
    ) ?? null
  );
}

export function findTabByPaneId(
  session: WorktreeTerminalSession | undefined,
  paneId: string,
): TerminalTab | null {
  if (!session) {
    return null;
  }
  return (
    session.tabs.find((tab) =>
      collectTerminalPanes(tab.node).some((pane) => pane.paneId === paneId),
    ) ?? null
  );
}

export function buildTerminalPaneTopologySignature(
  session: WorktreeTerminalSession | undefined,
): string {
  return session
    ? session.tabs
        .map((tab) =>
          collectTerminalPanes(tab.node)
            .map((pane) => pane.paneId)
            .join("|"),
        )
        .join("||")
    : "";
}

export function restoreLayoutWithPtyIds(
  node: SplitNode,
  panePtyIds: ReadonlyMap<string, string>,
): SplitNode {
  if (node.type === "leaf") {
    return {
      id: node.id,
      type: "leaf",
      ptyId: panePtyIds.get(node.id),
      ...(node.label ? { label: node.label } : {}),
    };
  }

  return {
    id: node.id,
    type: node.type,
    sizes: node.sizes,
    children: (node.children ?? []).map((child) => restoreLayoutWithPtyIds(child, panePtyIds)),
  };
}

export function buildTerminalRestorePlan(
  layout: SplitNode,
  snapshot: TerminalSessionSnapshot | null,
  defaultCwd: string,
): TerminalRestorePlanEntry[] {
  return collectTerminalPanes(layout).map(({ paneId }) => {
    const paneSnapshot = findPaneSnapshot(snapshot, paneId);
    const restoreCwd = paneSnapshot?.restoreCwd.trim() || defaultCwd;
    const launchCwd = paneSnapshot?.launchCwd.trim() || restoreCwd;

    return {
      paneId,
      launchCwd,
      lastKnownCwd: paneSnapshot?.lastKnownCwd ?? null,
      restoreCwd,
      restoreCwdSource: paneSnapshot?.restoreCwdSource ?? "fallback",
      scrollback: paneSnapshot?.scrollback ?? "",
      scrollbackTruncated: paneSnapshot?.scrollbackTruncated ?? false,
    };
  });
}

export function buildTerminalSnapshotRequest(
  worktreePath: string,
  session: WorktreeTerminalSession | undefined,
  paneLaunchCwds?: ReadonlyMap<string, string>,
): SaveTerminalSessionSnapshotRequest {
  return {
    worktreePath,
    panes: collectSessionPanes(session).map(({ paneId, ptyId }) => ({
      paneId,
      ptyId,
      launchCwd: paneLaunchCwds?.get(paneId),
    })),
  };
}

export function findWorktreePathForPtyId(
  sessions: Record<string, WorktreeTerminalSession>,
  ptyId: string,
): string | null {
  for (const [worktreePath, session] of Object.entries(sessions)) {
    if (collectSessionPanes(session).some((pane) => pane.ptyId === ptyId)) {
      return worktreePath;
    }
  }

  return null;
}
