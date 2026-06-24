import { describe, expect, it } from "vitest";
import { getFocusedProjects, hasFocusedProjects } from "./project-focus";
import type { Project } from "../types";

function project(id: string, focused: boolean): Project {
  return {
    id,
    name: id,
    url: "",
    org: "o",
    repo: id,
    sourcePath: `/tmp/${id}`,
    worktrees: [],
    sourceHasChanges: false,
    sourceBehindRemote: false,
    baseBranch: null,
    resolvedDefaultBranch: "main",
    collapsed: false,
    categoryId: "default",
    focused,
  };
}

describe("project-focus", () => {
  const projects = [project("a", false), project("b", true), project("c", false)];

  it("hasFocusedProjects is true when any project is focused", () => {
    expect(hasFocusedProjects(projects)).toBe(true);
    expect(hasFocusedProjects([project("a", false)])).toBe(false);
    expect(hasFocusedProjects([])).toBe(false);
  });

  it("getFocusedProjects returns only focused projects", () => {
    expect(getFocusedProjects(projects).map((p) => p.id)).toEqual(["b"]);
  });
});
