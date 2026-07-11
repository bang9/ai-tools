import { describe, expect, it } from "vitest";
import { shallow } from "zustand/shallow";
import type { SplitNode, WorktreeTerminalSession } from "../../types";
import type { AiSession } from "../../store/terminal";
import { selectAiWorktreeSessions, selectWorktreeBell } from "./worktree-status";

interface WorktreeStatusState {
  sessions: Record<string, WorktreeTerminalSession>;
  bellPtyIds: Set<string>;
  aiSessions: Record<string, AiSession>;
}

function makeLeaf(id: string, ptyId?: string): SplitNode {
  return {
    id,
    type: "leaf",
    ptyId,
  };
}

function makeSession(node: SplitNode, tabId = "tab-1"): WorktreeTerminalSession {
  return { tabs: [{ id: tabId, node }], activeTabId: tabId };
}

function makeState(overrides: Partial<WorktreeStatusState> = {}): WorktreeStatusState {
  return {
    sessions: {},
    bellPtyIds: new Set<string>(),
    aiSessions: {},
    ...overrides,
  };
}

describe("worktree status selectors", () => {
  it("returns a stable empty sessions array when the worktree has no session", () => {
    const state = makeState();

    const first = selectAiWorktreeSessions(state, "/tmp/source");
    const second = selectAiWorktreeSessions(state, "/tmp/source");

    expect(first).toBe(second);
    expect(first).toEqual([]);
  });

  it("stays shallow-equal for unchanged AI sessions", () => {
    const state = makeState({
      sessions: {
        "/tmp/source": makeSession({
          id: "root",
          type: "horizontal",
          sizes: [1, 1],
          children: [makeLeaf("pane-a", "pty-a"), makeLeaf("pane-b", "pty-b")],
        }),
      },
      aiSessions: {
        "pty-a": { tool: "claude", status: "running" },
        "pty-b": { tool: "codex", status: "running" },
      },
    });

    const first = selectAiWorktreeSessions(state, "/tmp/source");
    const second = selectAiWorktreeSessions(state, "/tmp/source");

    expect(first).not.toBe(second);
    expect(first).toEqual([
      { tool: "claude", status: "running" },
      { tool: "codex", status: "running" },
    ]);
    expect(shallow(first, second)).toBe(true);
  });

  it("detects terminal bell state for panes in the worktree", () => {
    const state = makeState({
      sessions: {
        "/tmp/source": makeSession(makeLeaf("pane-a", "pty-a")),
      },
      bellPtyIds: new Set(["pty-a"]),
    });

    expect(selectWorktreeBell(state, "/tmp/source")).toBe(true);
    expect(selectWorktreeBell(state, "/tmp/other")).toBe(false);
  });
});
