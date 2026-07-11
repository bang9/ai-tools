import { describe, expect, it, vi } from "vitest";
import { requestTerminalLayoutSync, subscribeTerminalLayoutSync } from "./terminal-layout-sync";

describe("terminal layout sync", () => {
  it("broadcasts manual sync requests to subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTerminalLayoutSync(listener);

    requestTerminalLayoutSync({ source: "panelResize" });

    expect(listener).toHaveBeenCalledWith({ source: "panelResize" });
    unsubscribe();
  });

  it("delivers scoped paneIds verbatim to subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTerminalLayoutSync(listener);

    const request = { source: "panelResize" as const, paneIds: ["pane-1", "pane-2"] };
    requestTerminalLayoutSync(request);

    expect(listener).toHaveBeenCalledWith(request);
    unsubscribe();
  });

  it("stops notifying listeners after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTerminalLayoutSync(listener);

    unsubscribe();
    requestTerminalLayoutSync({ paneId: "pane-1", source: "attach" });

    expect(listener).not.toHaveBeenCalled();
  });
});
