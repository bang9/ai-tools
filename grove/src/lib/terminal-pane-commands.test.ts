import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./platform", () => ({
  createPty: vi.fn(),
  closePty: vi.fn(),
  loadTerminalLayouts: vi.fn(),
  saveTerminalLayouts: vi.fn(),
  savePanelLayouts: vi.fn(),
  loadPanelLayouts: vi.fn(),
}));

vi.mock("./command", () => ({
  runCommand: vi.fn(async (fn: () => unknown) => fn()),
  runCommandSafely: vi.fn(async (fn: () => unknown) => {
    try {
      return await fn();
    } catch {
      return null;
    }
  }),
}));

vi.mock("./terminal-runtime", () => ({
  getRuntimeSize: vi.fn(() => ({ cols: 120, rows: 30 })),
  captureRuntimeSnapshot: vi.fn(() => "snapshot-data"),
}));

import * as platform from "./platform";
import { useTerminalStore } from "../store/terminal";
import { useBroadcastStore } from "../store/broadcast";
import { usePanelLayoutStore } from "../store/panel-layout";
import { countLeaves } from "./split-tree";
import { closeTerminalPane, mirrorTerminalPane, splitTerminalPane } from "./terminal-pane-commands";

const WORKTREE = "/tmp/worktree";

describe("terminal pane commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTerminalStore.setState({
      sessions: { [WORKTREE]: { id: "pane-1", type: "leaf", ptyId: "pty-1" } },
      activeWorktree: WORKTREE,
      focusedPtyId: "pty-1",
      focusedPaneIdByWorktree: { [WORKTREE]: "pane-1" },
      bellPtyIds: new Set<string>(),
      aiSessions: {},
    });
    useBroadcastStore.setState({ mirrors: {}, pips: {}, pipOwnerByPtyId: {} });
    usePanelLayoutStore.setState({
      globalTerminal: { collapsed: true, ratio: 0.3, tabs: [], activeTabId: "" },
    });
  });

  it("splits the targeted pane and focuses the new pane", async () => {
    await splitTerminalPane(WORKTREE, "pty-1", "vertical");

    expect(platform.createPty).toHaveBeenCalledWith(
      expect.objectContaining({ worktreePath: WORKTREE, cwd: WORKTREE }),
    );
    const state = useTerminalStore.getState();
    expect(countLeaves(state.sessions[WORKTREE])).toBe(2);
    expect(state.focusedPtyId).not.toBe("pty-1");
  });

  it("leaves the layout untouched when pty creation fails", async () => {
    vi.mocked(platform.createPty).mockRejectedValueOnce(new Error("spawn failed"));

    await splitTerminalPane(WORKTREE, "pty-1", "horizontal");

    const state = useTerminalStore.getState();
    expect(countLeaves(state.sessions[WORKTREE])).toBe(1);
    expect(state.focusedPtyId).toBe("pty-1");
  });

  it("closes the targeted pane and its pty", async () => {
    await splitTerminalPane(WORKTREE, "pty-1", "vertical");

    await closeTerminalPane(WORKTREE, "pty-1");

    expect(platform.closePty).toHaveBeenCalledWith("pty-1");
    const state = useTerminalStore.getState();
    expect(countLeaves(state.sessions[WORKTREE])).toBe(1);
    expect(state.focusedPtyId).not.toBe("pty-1");
  });

  it("starts a mirror and adds a global terminal tab for the pane", () => {
    mirrorTerminalPane("pane-1", "pty-1");

    const mirror = useBroadcastStore.getState().mirrors["pty-1"];
    expect(mirror).toMatchObject({
      paneId: "pane-1",
      originalCols: 120,
      originalRows: 30,
      snapshot: "snapshot-data",
    });
    const tabs = usePanelLayoutStore.getState().globalTerminal.tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0].mirrorPtyId).toBe("pty-1");
  });

  it("does not duplicate mirror tabs for an already mirrored pty", () => {
    mirrorTerminalPane("pane-1", "pty-1");
    mirrorTerminalPane("pane-1", "pty-1");

    expect(usePanelLayoutStore.getState().globalTerminal.tabs).toHaveLength(1);
  });
});
