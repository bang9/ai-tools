import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/platform", () => ({
  getGrovePreferences: vi.fn(),
  saveGrovePreferences: vi.fn().mockResolvedValue(undefined),
  deleteProjectCategory: vi.fn().mockResolvedValue(undefined),
}));

import * as platform from "../lib/platform";
import { usePreferencesStore } from "./preferences";

describe("usePreferencesStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePreferencesStore.setState({
      terminalLinkOpenMode: "external-with-localhost-internal",
      projectViewMode: "default",
      collapsedProjectOrgs: [],
      projectOrgOrder: [],
      ideMenuItems: [],
      gitGuiMenuItems: [],
      projectCategories: [],
      loaded: false,
    });
  });

  it("normalizes omitted optional preference fields during init", async () => {
    vi.mocked(platform.getGrovePreferences).mockResolvedValue({
      terminalLinkOpenMode: "external-with-localhost-internal",
      projectViewMode: "group-by-orgs",
    } as Awaited<ReturnType<typeof platform.getGrovePreferences>>);

    await usePreferencesStore.getState().init();

    expect(usePreferencesStore.getState()).toMatchObject({
      projectViewMode: "group-by-orgs",
      collapsedProjectOrgs: [],
      projectOrgOrder: [],
      ideMenuItems: [],
      gitGuiMenuItems: [],
      projectCategories: [],
      loaded: true,
    });
  });

  it("toggles org collapse after init when the backend omitted the array field", async () => {
    vi.mocked(platform.getGrovePreferences).mockResolvedValue({
      terminalLinkOpenMode: "external-with-localhost-internal",
      projectViewMode: "group-by-orgs",
    } as Awaited<ReturnType<typeof platform.getGrovePreferences>>);

    await usePreferencesStore.getState().init();
    usePreferencesStore.getState().setProjectOrgCollapsed("sendbird", true);

    expect(usePreferencesStore.getState().collapsedProjectOrgs).toEqual(["sendbird"]);
    expect(platform.saveGrovePreferences).toHaveBeenCalledWith(
      expect.objectContaining({
        collapsedProjectOrgs: ["sendbird"],
      }),
    );
  });

  it("saves unique org order values", () => {
    usePreferencesStore
      .getState()
      .setProjectOrgOrder(["sendbird", "bang9", "sendbird"]);

    expect(usePreferencesStore.getState().projectOrgOrder).toEqual([
      "sendbird",
      "bang9",
    ]);
    expect(platform.saveGrovePreferences).toHaveBeenCalledWith(
      expect.objectContaining({
        projectOrgOrder: ["sendbird", "bang9"],
      }),
    );
  });
});
