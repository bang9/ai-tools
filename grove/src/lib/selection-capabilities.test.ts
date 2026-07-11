import { describe, expect, it } from "vitest";
import { resolveSelectionCapabilities } from "./selection-capabilities";

describe("resolveSelectionCapabilities", () => {
  it("grants everything for a git-backed worktree selection", () => {
    const caps = resolveSelectionCapabilities({
      terminalPath: "/tmp/wt",
      worktreePath: "/tmp/wt",
    });
    expect(caps).toEqual({
      hasDirectory: true,
      hasGit: true,
      terminal: true,
      browser: true,
      fileBrowser: true,
      changes: true,
      commits: true,
    });
  });

  it("blocks git features for a plain directory (mission root)", () => {
    const caps = resolveSelectionCapabilities({
      terminalPath: "/tmp/mission-root",
      worktreePath: null,
    });
    expect(caps.hasDirectory).toBe(true);
    expect(caps.hasGit).toBe(false);
    expect(caps.terminal).toBe(true);
    expect(caps.browser).toBe(true);
    expect(caps.fileBrowser).toBe(true);
    expect(caps.changes).toBe(false);
    expect(caps.commits).toBe(false);
  });

  it("grants nothing without a selection", () => {
    const caps = resolveSelectionCapabilities({ terminalPath: null, worktreePath: null });
    expect(caps.hasDirectory).toBe(false);
    expect(caps.terminal).toBe(false);
    expect(caps.browser).toBe(false);
    expect(caps.fileBrowser).toBe(false);
    expect(caps.changes).toBe(false);
    expect(caps.commits).toBe(false);
  });
});
