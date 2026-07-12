import { describe, expect, it } from "vitest";

import { resolveNewWindowTarget } from "./browser-new-window";

const SESSIONS = {
  "/tmp/a": { tabs: [{ id: "a-1" }, { id: "a-2" }] },
  "/tmp/b": { tabs: [{ id: "b-1" }] },
};

describe("resolveNewWindowTarget", () => {
  it("routes to the opener's worktree without activating when it is in the background", () => {
    expect(resolveNewWindowTarget(SESSIONS, "/tmp/a", "b-1")).toEqual({
      worktreePath: "/tmp/b",
      activate: false,
    });
  });

  it("routes to the opener's worktree and activates when it is the active one", () => {
    expect(resolveNewWindowTarget(SESSIONS, "/tmp/a", "a-2")).toEqual({
      worktreePath: "/tmp/a",
      activate: true,
    });
  });

  it("falls back to the active session for an unknown opener", () => {
    expect(resolveNewWindowTarget(SESSIONS, "/tmp/a", "missing")).toEqual({
      worktreePath: null,
      activate: true,
    });
  });

  it("falls back to the active session for an empty opener", () => {
    expect(resolveNewWindowTarget(SESSIONS, "/tmp/a", "")).toEqual({
      worktreePath: null,
      activate: true,
    });
  });

  it("falls back to the active session when there are no sessions at all", () => {
    expect(resolveNewWindowTarget({}, null, "a-1")).toEqual({
      worktreePath: null,
      activate: true,
    });
  });
});
