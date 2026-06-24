import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, SplitNode, Worktree } from "../types";

const runCommandMock = vi.fn();
const runCommandSafelyMock = vi.fn();

vi.mock("../lib/command", () => ({
  runCommand: (...args: Parameters<typeof runCommandMock>) =>
    runCommandMock(...args),
  runCommandSafely: (...args: Parameters<typeof runCommandSafelyMock>) =>
    runCommandSafelyMock(...args),
}));

vi.mock("../lib/platform", () => ({
  listProjects: vi.fn(),
  refreshProject: vi.fn(),
  startClone: vi.fn(),
  removeProject: vi.fn(),
  addWorktree: vi.fn(),
  addStackedWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  renameProject: vi.fn(),
  setProjectCategory: vi.fn(),
  setProjectCollapsed: vi.fn(),
  runTerminalGc: vi.fn().mockResolvedValue({
    staleWorktreePaths: [],
    staleSessionNames: [],
    prunedWorktreePaths: [],
    killedSessionNames: [],
    skippedAttachedWorktreePaths: [],
    leftoverProcessIds: [],
  }),
}));

import * as tauri from "../lib/platform";
import { useProjectStore } from "./project";
import { useBroadcastStore } from "./broadcast";
import { useTerminalStore } from "./terminal";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeWorktree(name: string, branch = name): Worktree {
  return {
    name,
    path: `/tmp/${name}`,
    branch,
  };
}

function makeProject(worktrees: Worktree[]): Project {
  return {
    id: "project-1",
    name: "grove",
    url: "https://github.com/bang9/grove.git",
    org: "bang9",
    repo: "grove",
    sourcePath: "/tmp/source",
    sourceHasChanges: false,
    sourceBehindRemote: false,
    baseBranch: null,
    resolvedDefaultBranch: "main",
    collapsed: false,
    categoryId: "default",
    focused: false,
    worktrees,
  };
}

function makeLeaf(id: string, ptyId: string): SplitNode {
  return {
    id,
    type: "leaf",
    ptyId,
  };
}

function makeProjectWithId(
  id: string,
  overrides: Partial<Project> = {},
): Project {
  return {
    ...makeProject([]),
    id,
    ...overrides,
  };
}

describe("useProjectStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runCommandMock.mockImplementation(async (action: () => Promise<unknown>) =>
      action(),
    );
    runCommandSafelyMock.mockImplementation(
      async (action: () => Promise<unknown>) => action(),
    );
    useProjectStore.setState({
      projects: [],
      cloningProjects: [],
      selectedWorktree: null,
      loading: false,
      projectsSnapshotRequestId: 0,
      projectsMutationEpoch: 0,
    });
    useTerminalStore.setState({
      sessions: {},
      activeWorktree: null,
      focusedPtyId: null,
      focusedPaneIdByWorktree: {},
      bellPtyIds: new Set<string>(),
      aiSessions: {},
      theme: null,
      detectedTheme: null,
    });
    useBroadcastStore.setState({
      mirrors: {},
      pips: {},
      pipOwnerByPtyId: {},
    });
  });

  it("clears selectedWorktree when refresh removes the selected worktree", async () => {
    const selectedWorktree = makeWorktree("feature-a");
    useProjectStore.setState({
      projects: [makeProject([selectedWorktree])],
      selectedWorktree,
      loading: false,
    });

    vi.mocked(tauri.refreshProject).mockResolvedValue(makeProject([]));

    await useProjectStore.getState().refreshProject("project-1");

    expect(useProjectStore.getState().selectedWorktree).toBeNull();
  });

  it("reconciles selectedWorktree to the refreshed project data", async () => {
    const selectedWorktree = makeWorktree("feature-a", "old-branch");
    const refreshedWorktree = {
      ...selectedWorktree,
      branch: "new-branch",
    };
    useProjectStore.setState({
      projects: [makeProject([selectedWorktree])],
      selectedWorktree,
      loading: false,
    });

    vi.mocked(tauri.refreshProject).mockResolvedValue(
      makeProject([refreshedWorktree]),
    );

    await useProjectStore.getState().refreshProject("project-1");

    expect(useProjectStore.getState().selectedWorktree).toEqual(refreshedWorktree);
    expect(useProjectStore.getState().selectedWorktree).not.toBe(
      selectedWorktree,
    );
  });

  it("upserts existing project when startClone returns alreadyExists", async () => {
    useProjectStore.setState({
      projects: [
        makeProjectWithId("project-1", {
          name: "old-name",
          sourcePath: "/tmp/source",
          url: "https://github.com/bang9/grove.git",
        }),
      ],
      cloningProjects: [],
      selectedWorktree: null,
      loading: false,
    });

    const returnedProject = makeProjectWithId("project-1", {
      name: "grove",
      sourcePath: "/tmp/source",
      url: "git@github.com:bang9/grove.git",
    });
    vi.mocked(tauri.startClone).mockResolvedValue({
      type: "alreadyExists",
      ...returnedProject,
    });

    await useProjectStore.getState().startClone("git@github.com:bang9/grove.git");

    expect(useProjectStore.getState().projects).toEqual([returnedProject]);
    expect(useProjectStore.getState().cloningProjects).toEqual([]);
  });

  it("adds to cloningProjects when startClone returns cloning", async () => {
    useProjectStore.setState({
      projects: [],
      cloningProjects: [],
      selectedWorktree: null,
      loading: false,
    });

    vi.mocked(tauri.startClone).mockResolvedValue({
      type: "cloning",
      id: "clone-1",
      url: "git@github.com:bang9/grove.git",
      org: "bang9",
      repo: "grove",
    });

    await useProjectStore.getState().startClone("git@github.com:bang9/grove.git");

    expect(useProjectStore.getState().cloningProjects).toEqual([
      { id: "clone-1", url: "git@github.com:bang9/grove.git", org: "bang9", repo: "grove" },
    ]);
    expect(useProjectStore.getState().projects).toEqual([]);
  });

  it("selects source worktree after removing the selected worktree", async () => {
    const selectedWorktree = makeWorktree("feature-a");
    useProjectStore.setState({
      projects: [makeProject([selectedWorktree])],
      selectedWorktree,
      loading: false,
    });

    useTerminalStore.setState({
      sessions: {
        [selectedWorktree.path]: makeLeaf("pane-feature", "pty-feature"),
        "/tmp/source": makeLeaf("pane-source", "pty-source"),
      },
      activeWorktree: selectedWorktree.path,
      focusedPtyId: "pty-feature",
    });
    vi.mocked(tauri.removeWorktree).mockResolvedValue();

    await useProjectStore.getState().removeWorktree("project-1", "feature-a");

    expect(useProjectStore.getState().selectedWorktree).toEqual({
      name: "source",
      path: "/tmp/source",
      branch: "main",
      stackParentName: null,
    });
    expect(useTerminalStore.getState().sessions[selectedWorktree.path]).toBeUndefined();
    expect(useTerminalStore.getState().activeWorktree).toBe("/tmp/source");
    expect(useTerminalStore.getState().focusedPtyId).toBe("pty-source");
  });

  it("clears broadcast state tied to a removed worktree", async () => {
    const selectedWorktree = makeWorktree("feature-a");
    useProjectStore.setState({
      projects: [makeProject([selectedWorktree])],
      selectedWorktree,
      loading: false,
    });
    useTerminalStore.setState({
      sessions: {
        [selectedWorktree.path]: makeLeaf("pane-feature", "pty-feature"),
      },
      activeWorktree: selectedWorktree.path,
      focusedPtyId: "pty-feature",
    });
    useBroadcastStore.getState().startMirror("pty-feature", "pane-feature", 120, 30);
    useBroadcastStore
      .getState()
      .startPip(selectedWorktree.path, "pty-feature", "pane-feature", 80, 24);
    vi.mocked(tauri.removeWorktree).mockResolvedValue();

    await useProjectStore.getState().removeWorktree("project-1", "feature-a");

    expect(useBroadcastStore.getState().mirrors["pty-feature"]).toBeUndefined();
    expect(useBroadcastStore.getState().pips[selectedWorktree.path]).toBeUndefined();
  });

  it("renames a project and updates state", async () => {
    useProjectStore.setState({
      projects: [makeProject([])],
      selectedWorktree: null,
      loading: false,
    });

    vi.mocked(tauri.renameProject).mockResolvedValue();

    await useProjectStore.getState().renameProject("project-1", "my-custom-name");

    const project = useProjectStore.getState().projects[0];
    expect(project.name).toBe("my-custom-name");
    expect(tauri.renameProject).toHaveBeenCalledWith("project-1", "my-custom-name");
  });

  it("keeps the current selection when removing a different worktree", async () => {
    const selectedWorktree = makeWorktree("feature-a");
    const otherWorktree = makeWorktree("feature-b");
    useProjectStore.setState({
      projects: [makeProject([selectedWorktree, otherWorktree])],
      selectedWorktree,
      loading: false,
    });

    vi.mocked(tauri.removeWorktree).mockResolvedValue();

    await useProjectStore.getState().removeWorktree("project-1", "feature-b");

    expect(useProjectStore.getState().selectedWorktree).toEqual(selectedWorktree);
  });

  it("ignores a stale project snapshot after adding a worktree", async () => {
    useProjectStore.setState({
      projects: [makeProject([])],
      cloningProjects: [],
      selectedWorktree: null,
      loading: false,
    });

    const staleSnapshot = deferred<Project[]>();
    vi.mocked(tauri.listProjects).mockReturnValueOnce(staleSnapshot.promise);

    const newWorktree = makeWorktree("feature-a");
    vi.mocked(tauri.addWorktree).mockResolvedValue(newWorktree);

    const syncPromise = useProjectStore.getState().syncProjects();
    await useProjectStore.getState().addWorktree("project-1", "feature-a");

    staleSnapshot.resolve([makeProject([])]);
    await syncPromise;

    expect(useProjectStore.getState().projects[0]?.worktrees).toEqual([newWorktree]);
  });

  it("does not duplicate a worktree when sync applies it before addWorktree resolves", async () => {
    useProjectStore.setState({
      projects: [makeProject([])],
      cloningProjects: [],
      selectedWorktree: null,
      loading: false,
    });

    const newWorktree = makeWorktree("feature-a");
    const addDeferred = deferred<Worktree>();
    vi.mocked(tauri.addWorktree).mockReturnValueOnce(addDeferred.promise);
    vi.mocked(tauri.listProjects).mockResolvedValueOnce([
      makeProject([newWorktree]),
    ]);

    const addPromise = useProjectStore
      .getState()
      .addWorktree("project-1", "feature-a");

    await useProjectStore.getState().syncProjects();

    expect(useProjectStore.getState().projects[0]?.worktrees).toEqual([
      newWorktree,
    ]);

    addDeferred.resolve(newWorktree);
    await addPromise;

    expect(useProjectStore.getState().projects[0]?.worktrees).toEqual([
      newWorktree,
    ]);
  });

  it("adds a stacked worktree to the matching project", async () => {
    useProjectStore.setState({
      projects: [makeProject([makeWorktree("feature-a")])],
      cloningProjects: [],
      selectedWorktree: null,
      loading: false,
    });

    const stackedWorktree = makeWorktree("feature-a/fix-token");
    stackedWorktree.stackParentName = "feature-a";
    vi.mocked(tauri.addStackedWorktree).mockResolvedValue(stackedWorktree);

    await useProjectStore
      .getState()
      .addStackedWorktree("project-1", "feature-a", "feature-a/fix-token");

    expect(useProjectStore.getState().projects[0]?.worktrees).toEqual([
      makeWorktree("feature-a"),
      stackedWorktree,
    ]);
  });

  it("does not duplicate a stacked worktree when sync applies it before addStackedWorktree resolves", async () => {
    const parent = makeWorktree("chore/align-types");
    const stackedChild = makeWorktree("chore/align-types/fix-token");
    stackedChild.stackParentName = "chore/align-types";

    useProjectStore.setState({
      projects: [makeProject([parent])],
      cloningProjects: [],
      selectedWorktree: null,
      loading: false,
    });

    const addDeferred = deferred<Worktree>();
    vi.mocked(tauri.addStackedWorktree).mockReturnValueOnce(addDeferred.promise);
    vi.mocked(tauri.listProjects).mockResolvedValueOnce([
      makeProject([parent, stackedChild]),
    ]);

    const addPromise = useProjectStore
      .getState()
      .addStackedWorktree("project-1", parent.name, stackedChild.name);

    await useProjectStore.getState().syncProjects();

    expect(useProjectStore.getState().projects[0]?.worktrees).toEqual([
      parent,
      stackedChild,
    ]);

    addDeferred.resolve(stackedChild);
    await addPromise;

    expect(useProjectStore.getState().projects[0]?.worktrees).toEqual([
      parent,
      stackedChild,
    ]);
  });

  it("ignores an in-flight stale snapshot while adding a stacked worktree", async () => {
    const parent = makeWorktree("chore/align-types");
    const topLevelChild = makeWorktree("bundle-size/chat-test-1");
    const stackedChild = makeWorktree("bundle-size/chat-test-1");
    stackedChild.stackParentName = "chore/align-types";

    useProjectStore.setState({
      projects: [makeProject([parent])],
      cloningProjects: [],
      selectedWorktree: null,
      loading: false,
    });

    const staleSnapshot = deferred<Project[]>();
    const createStacked = deferred<Worktree>();
    vi.mocked(tauri.listProjects).mockReturnValueOnce(staleSnapshot.promise);
    vi.mocked(tauri.addStackedWorktree).mockReturnValueOnce(createStacked.promise);

    const syncPromise = useProjectStore.getState().syncProjects();
    const addPromise = useProjectStore
      .getState()
      .addStackedWorktree("project-1", parent.name, stackedChild.name);

    staleSnapshot.resolve([makeProject([parent, topLevelChild])]);
    await syncPromise;

    expect(useProjectStore.getState().projects[0]?.worktrees).toEqual([parent]);

    createStacked.resolve(stackedChild);
    await addPromise;

    expect(useProjectStore.getState().projects[0]?.worktrees).toEqual([
      parent,
      stackedChild,
    ]);
  });

  it("ignores a stale project snapshot after removing a worktree", async () => {
    const worktree = makeWorktree("feature-a");
    useProjectStore.setState({
      projects: [makeProject([worktree])],
      cloningProjects: [],
      selectedWorktree: worktree,
      loading: false,
    });

    const staleSnapshot = deferred<Project[]>();
    vi.mocked(tauri.listProjects).mockReturnValueOnce(staleSnapshot.promise);
    vi.mocked(tauri.removeWorktree).mockResolvedValue();

    const syncPromise = useProjectStore.getState().syncProjects();
    await useProjectStore.getState().removeWorktree("project-1", "feature-a");

    staleSnapshot.resolve([makeProject([worktree])]);
    await syncPromise;

    expect(useProjectStore.getState().projects[0]?.worktrees).toEqual([]);
  });

  it("applies only the latest snapshot when requests resolve out of order", async () => {
    useProjectStore.setState({
      projects: [makeProject([])],
      cloningProjects: [],
      selectedWorktree: null,
      loading: false,
    });

    const olderSnapshot = deferred<Project[]>();
    const latestSnapshot = deferred<Project[]>();
    vi.mocked(tauri.listProjects)
      .mockReturnValueOnce(olderSnapshot.promise)
      .mockReturnValueOnce(latestSnapshot.promise);

    const firstSync = useProjectStore.getState().syncProjects();
    const secondSync = useProjectStore.getState().syncProjects();

    const latestProjects = [makeProject([makeWorktree("feature-b")])];
    latestSnapshot.resolve(latestProjects);
    await secondSync;

    olderSnapshot.resolve([makeProject([])]);
    await firstSync;

    expect(useProjectStore.getState().projects).toEqual(latestProjects);
  });
});
