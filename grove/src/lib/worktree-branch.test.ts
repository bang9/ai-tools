import { describe, expect, it } from "vitest";
import type { Mission, Project } from "../types";
import { resolveWorktreeBranchLabel } from "./worktree-branch";

const project: Project = {
  id: "p1",
  name: "Grove",
  url: "https://github.com/sendbird-playground/grove.git",
  org: "sendbird-playground",
  repo: "grove",
  sourcePath: "/repo/source",
  worktrees: [
    {
      name: "feature/sdk-v5",
      path: "/repo/worktrees/feature-sdk-v5",
      branch: "feature/sdk-v5",
    },
  ],
  sourceHasChanges: false,
  sourceBehindRemote: false,
  baseBranch: null,
  resolvedDefaultBranch: "main",
  collapsed: false,
  categoryId: "default",
  focused: false,
};

const mission: Mission = {
  id: "m1",
  name: "Mission",
  branchName: "mission/sdk-v5",
  missionDir: "/missions/m1",
  collapsed: false,
  projects: [
    {
      projectId: "p1",
      branch: "mission/sdk-v5",
      path: "/missions/m1/grove",
    },
  ],
};

describe("resolveWorktreeBranchLabel", () => {
  it("uses the selected project worktree branch", () => {
    expect(
      resolveWorktreeBranchLabel({
        projects: [project],
        missions: [],
        worktreePath: "/repo/worktrees/feature-sdk-v5",
      }),
    ).toBe("feature/sdk-v5");
  });

  it("uses the mission project branch", () => {
    expect(
      resolveWorktreeBranchLabel({
        projects: [project],
        missions: [mission],
        worktreePath: "/missions/m1/grove",
      }),
    ).toBe("mission/sdk-v5");
  });

  it("uses the source default branch for source paths", () => {
    expect(
      resolveWorktreeBranchLabel({
        projects: [project],
        missions: [],
        worktreePath: "/repo/source",
      }),
    ).toBe("main");
  });
});
