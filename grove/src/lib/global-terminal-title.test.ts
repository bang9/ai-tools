import { describe, expect, it } from "vitest";
import type { Project, Worktree } from "../types";
import {
  findProjectForWorktreePath,
  getGlobalTerminalMirrorTitle,
} from "./global-terminal-title";

function makeWorktree(name: string, path: string, branch: string): Worktree {
  return { name, path, branch };
}

function makeProject(worktrees: Worktree[] = []): Project {
  return {
    id: "project-1",
    name: "grove",
    url: "git@github.com:bang9/grove.git",
    org: "bang9",
    repo: "grove",
    sourcePath: "/tmp/bang9/grove/source",
    worktrees,
    sourceHasChanges: false,
    sourceBehindRemote: false,
    baseBranch: null,
    resolvedDefaultBranch: "main",
    collapsed: false,
    categoryId: "default",
    focused: false,
  };
}

describe("findProjectForWorktreePath", () => {
  it("matches the source path as a valid project target", () => {
    const project = makeProject();

    expect(findProjectForWorktreePath([project], project.sourcePath)).toBe(project);
  });
});

describe("getGlobalTerminalMirrorTitle", () => {
  it("uses the source branch for source broadcasts", () => {
    const source = makeWorktree("source", "/tmp/bang9/grove/source", "develop");

    expect(getGlobalTerminalMirrorTitle([makeProject()], source)).toBe(
      "bang9/grove > develop",
    );
  });

  it("keeps the worktree name for non-source broadcasts", () => {
    const worktree = makeWorktree("feature-abc", "/tmp/bang9/grove/feature-abc", "feature/abc");

    expect(getGlobalTerminalMirrorTitle([makeProject([worktree])], worktree)).toBe(
      "bang9/grove > feature-abc",
    );
  });
});
