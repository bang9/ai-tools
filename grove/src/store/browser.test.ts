import { beforeEach, describe, expect, it } from "vitest";
import { useBrowserStore } from "./browser";
import type { BrowserNavEvent } from "../lib/platform";

function navEvent(
  partial: Partial<BrowserNavEvent> & { tabId: string; url: string },
): BrowserNavEvent {
  return {
    title: null,
    loading: false,
    canGoBack: null,
    canGoForward: null,
    ...partial,
  };
}

describe("useBrowserStore", () => {
  beforeEach(() => {
    useBrowserStore.setState({ navs: {}, history: [] });
  });

  describe("navigate", () => {
    it("creates nav state with loading true", () => {
      useBrowserStore.getState().navigate("t1", "http://localhost:3000/");
      expect(useBrowserStore.getState().navs.t1).toEqual({
        url: "http://localhost:3000/",
        title: null,
        loading: true,
        canGoBack: false,
        canGoForward: false,
        history: ["http://localhost:3000/"],
        index: 0,
      });
    });

    it("appends to history and moves index", () => {
      const store = useBrowserStore.getState();
      store.navigate("t1", "http://a/");
      store.navigate("t1", "http://b/");
      const nav = useBrowserStore.getState().navs.t1;
      expect(nav.url).toBe("http://b/");
      expect(nav.history).toEqual(["http://a/", "http://b/"]);
      expect(nav.index).toBe(1);
      expect(nav.canGoBack).toBe(true);
    });

    it("navigate to the same url is a no-op", () => {
      const store = useBrowserStore.getState();
      store.navigate("t1", "http://a/");
      store.navigate("t1", "http://a/");
      expect(useBrowserStore.getState().navs.t1.history).toEqual(["http://a/"]);
    });

    it("navigate after moving back truncates forward history", () => {
      const store = useBrowserStore.getState();
      store.navigate("t1", "http://a/");
      store.navigate("t1", "http://b/");
      // Simulate a native back event.
      store.applyNavEvent(navEvent({ tabId: "t1", url: "http://a/" }));
      store.navigate("t1", "http://c/");
      const nav = useBrowserStore.getState().navs.t1;
      expect(nav.history).toEqual(["http://a/", "http://c/"]);
      expect(nav.index).toBe(1);
      expect(nav.url).toBe("http://c/");
    });
  });

  describe("applyNavEvent", () => {
    it("ignores events for unknown tabs (never creates entries)", () => {
      useBrowserStore.getState().applyNavEvent(navEvent({ tabId: "ghost", url: "http://a/" }));
      expect(useBrowserStore.getState().navs.ghost).toBeUndefined();
    });

    it("updates loading/title in place for the current url", () => {
      const store = useBrowserStore.getState();
      store.navigate("t1", "http://a/");
      store.applyNavEvent(
        navEvent({ tabId: "t1", url: "http://a/", loading: false, title: "Alpha" }),
      );
      const nav = useBrowserStore.getState().navs.t1;
      expect(nav.loading).toBe(false);
      expect(nav.title).toBe("Alpha");
      expect(nav.history).toEqual(["http://a/"]);
      expect(nav.index).toBe(0);
    });

    it("keeps the existing title when the event title is null", () => {
      const store = useBrowserStore.getState();
      store.navigate("t1", "http://a/");
      store.applyNavEvent(navEvent({ tabId: "t1", url: "http://a/", title: "Alpha" }));
      store.applyNavEvent(navEvent({ tabId: "t1", url: "http://a/", title: null }));
      expect(useBrowserStore.getState().navs.t1.title).toBe("Alpha");
    });

    it("treats a url matching the previous entry as a back navigation", () => {
      const store = useBrowserStore.getState();
      store.navigate("t1", "http://a/");
      store.navigate("t1", "http://b/");
      store.applyNavEvent(navEvent({ tabId: "t1", url: "http://a/" }));
      const nav = useBrowserStore.getState().navs.t1;
      expect(nav.index).toBe(0);
      expect(nav.url).toBe("http://a/");
      expect(nav.history).toEqual(["http://a/", "http://b/"]);
    });

    it("treats a url matching the next entry as a forward navigation", () => {
      const store = useBrowserStore.getState();
      store.navigate("t1", "http://a/");
      store.navigate("t1", "http://b/");
      store.applyNavEvent(navEvent({ tabId: "t1", url: "http://a/" })); // back
      store.applyNavEvent(navEvent({ tabId: "t1", url: "http://b/" })); // forward
      const nav = useBrowserStore.getState().navs.t1;
      expect(nav.index).toBe(1);
      expect(nav.url).toBe("http://b/");
      expect(nav.history).toEqual(["http://a/", "http://b/"]);
    });

    it("replaces the current entry when a settled load reports a new url (redirect)", () => {
      const store = useBrowserStore.getState();
      store.navigate("t1", "http://naver.com/");
      store.applyNavEvent(navEvent({ tabId: "t1", url: "http://naver.com/", loading: true }));
      store.applyNavEvent(navEvent({ tabId: "t1", url: "https://www.naver.com/", loading: false }));
      const nav = useBrowserStore.getState().navs.t1;
      expect(nav.history).toEqual(["https://www.naver.com/"]);
      expect(nav.index).toBe(0);
      expect(nav.url).toBe("https://www.naver.com/");
      expect(nav.canGoBack).toBe(false);
    });

    it("back lands on the redirect-canonical url, not a phantom entry", () => {
      const store = useBrowserStore.getState();
      // google.com typed → redirects
      store.navigate("t1", "http://google.com/");
      store.applyNavEvent(
        navEvent({ tabId: "t1", url: "https://www.google.com/", loading: false }),
      );
      // naver.com typed → redirects
      store.navigate("t1", "http://naver.com/");
      store.applyNavEvent(navEvent({ tabId: "t1", url: "http://naver.com/", loading: true }));
      store.applyNavEvent(navEvent({ tabId: "t1", url: "https://www.naver.com/", loading: false }));
      let nav = useBrowserStore.getState().navs.t1;
      expect(nav.history).toEqual(["https://www.google.com/", "https://www.naver.com/"]);
      expect(nav.index).toBe(1);
      // Back = explicit navigation to history[0]; the load-start event must be
      // recognized as a back move, not a push.
      store.applyNavEvent(navEvent({ tabId: "t1", url: "https://www.google.com/", loading: true }));
      nav = useBrowserStore.getState().navs.t1;
      expect(nav.index).toBe(0);
      expect(nav.history).toHaveLength(2);
      expect(nav.canGoForward).toBe(true);
    });

    it("still pushes for a brand-new url while loading (link click)", () => {
      const store = useBrowserStore.getState();
      store.navigate("t1", "http://a/");
      store.applyNavEvent(navEvent({ tabId: "t1", url: "http://b/", loading: true }));
      const nav = useBrowserStore.getState().navs.t1;
      expect(nav.history).toEqual(["http://a/", "http://b/"]);
      expect(nav.index).toBe(1);
    });

    it("pushes and truncates forward history for a brand-new url", () => {
      const store = useBrowserStore.getState();
      store.navigate("t1", "http://a/");
      store.navigate("t1", "http://b/");
      store.applyNavEvent(navEvent({ tabId: "t1", url: "http://a/" })); // back to index 0
      // native link nav — real navigations announce themselves with a
      // load-start event (settled-load URL changes are treated as redirects)
      store.applyNavEvent(navEvent({ tabId: "t1", url: "http://c/", loading: true }));
      const nav = useBrowserStore.getState().navs.t1;
      expect(nav.history).toEqual(["http://a/", "http://c/"]);
      expect(nav.index).toBe(1);
      expect(nav.url).toBe("http://c/");
    });

    it("falls back to the stack heuristic when canGoBack/Forward are null", () => {
      const store = useBrowserStore.getState();
      store.navigate("t1", "http://a/");
      store.navigate("t1", "http://b/");
      store.applyNavEvent(
        navEvent({ tabId: "t1", url: "http://b/", canGoBack: null, canGoForward: null }),
      );
      const nav = useBrowserStore.getState().navs.t1;
      expect(nav.canGoBack).toBe(true); // index 1 > 0
      expect(nav.canGoForward).toBe(false); // index 1 === history.length - 1
    });

    it("uses explicit canGoBack/Forward booleans when provided", () => {
      const store = useBrowserStore.getState();
      store.navigate("t1", "http://a/");
      store.applyNavEvent(
        navEvent({
          tabId: "t1",
          url: "http://a/",
          canGoBack: true,
          canGoForward: true,
        }),
      );
      const nav = useBrowserStore.getState().navs.t1;
      // Explicit booleans win over the stack heuristic (which would be false).
      expect(nav.canGoBack).toBe(true);
      expect(nav.canGoForward).toBe(true);
    });

    describe("titleOnly events are pure metadata (never touch history)", () => {
      it("a title event arriving BEFORE the load-start does not collapse the back stack", () => {
        // The exact Tauri race: WKWebView fires on_document_title_changed for the
        // destination page (a settled loading=false event carrying the new URL)
        // BEFORE the page-load Started event. Without titleOnly it was misread as
        // a same-page redirect and REPLACED history[0], collapsing the stack so
        // canGoBack (derived from the FE index on Tauri) stayed false forever.
        const store = useBrowserStore.getState();
        store.navigate("t1", "https://a.example/");
        store.applyNavEvent(
          navEvent({
            tabId: "t1",
            url: "https://b.example/",
            title: "B",
            loading: false,
            titleOnly: true,
          }),
        );
        store.applyNavEvent(navEvent({ tabId: "t1", url: "https://b.example/", loading: true }));
        store.applyNavEvent(navEvent({ tabId: "t1", url: "https://b.example/", loading: false }));
        const nav = useBrowserStore.getState().navs.t1;
        expect(nav.history).toEqual(["https://a.example/", "https://b.example/"]);
        expect(nav.index).toBe(1);
        expect(nav.canGoBack).toBeTruthy();
        expect(nav.title).toBe("B");
      });

      it("a title event arriving AFTER the commit applies the title without corrupting the stack", () => {
        const store = useBrowserStore.getState();
        store.navigate("t1", "https://a.example/");
        // Link nav to B announces itself with a load-start push, then settles.
        store.applyNavEvent(navEvent({ tabId: "t1", url: "https://b.example/", loading: true }));
        store.applyNavEvent(navEvent({ tabId: "t1", url: "https://b.example/", loading: false }));
        // Title resolves after the page committed.
        store.applyNavEvent(
          navEvent({ tabId: "t1", url: "https://b.example/", title: "B site", titleOnly: true }),
        );
        const nav = useBrowserStore.getState().navs.t1;
        expect(nav.history).toEqual(["https://a.example/", "https://b.example/"]);
        expect(nav.index).toBe(1);
        expect(nav.url).toBe("https://b.example/");
        expect(nav.title).toBe("B site");
      });

      it("a title event does not touch url/loading/index", () => {
        const store = useBrowserStore.getState();
        store.navigate("t1", "https://a.example/");
        store.applyNavEvent(navEvent({ tabId: "t1", url: "https://a.example/", loading: false }));
        // Title event reports a stale/other URL — must not move the tab there.
        store.applyNavEvent(
          navEvent({
            tabId: "t1",
            url: "https://elsewhere.example/",
            title: "Elsewhere",
            titleOnly: true,
          }),
        );
        const nav = useBrowserStore.getState().navs.t1;
        expect(nav.url).toBe("https://a.example/");
        expect(nav.loading).toBe(false);
        expect(nav.index).toBe(0);
        expect(nav.history).toEqual(["https://a.example/"]);
        expect(nav.title).toBe("Elsewhere");
      });

      it("a GENUINE redirect (not titleOnly) still replaces the current entry", () => {
        const store = useBrowserStore.getState();
        store.navigate("t1", "https://redirect-src/");
        store.applyNavEvent(navEvent({ tabId: "t1", url: "https://redirect-src/", loading: true }));
        store.applyNavEvent(navEvent({ tabId: "t1", url: "https://redirected/", loading: false }));
        const nav = useBrowserStore.getState().navs.t1;
        expect(nav.history).toEqual(["https://redirected/"]);
        expect(nav.index).toBe(0);
        expect(nav.url).toBe("https://redirected/");
      });
    });
  });

  describe("jumpHistory", () => {
    function threeEntryTab() {
      const store = useBrowserStore.getState();
      store.navigate("t1", "http://a/");
      store.navigate("t1", "http://b/");
      store.navigate("t1", "http://c/");
      return store;
    }

    it("jumps back multiple steps: index, url, and flags update, history intact", () => {
      const store = threeEntryTab();
      store.jumpHistory("t1", 0); // from index 2 back to 0
      const nav = useBrowserStore.getState().navs.t1;
      expect(nav.index).toBe(0);
      expect(nav.url).toBe("http://a/");
      expect(nav.loading).toBe(true);
      expect(nav.canGoBack).toBe(false);
      expect(nav.canGoForward).toBe(true);
      // The stack itself must not change — only our position in it moves.
      expect(nav.history).toEqual(["http://a/", "http://b/", "http://c/"]);
    });

    it("jumps forward multiple steps and sets flags for a middle entry", () => {
      const store = threeEntryTab();
      store.jumpHistory("t1", 0); // go to the start first
      store.jumpHistory("t1", 2); // forward two steps to the end
      let nav = useBrowserStore.getState().navs.t1;
      expect(nav.index).toBe(2);
      expect(nav.url).toBe("http://c/");
      expect(nav.canGoForward).toBe(false);
      // Middle entry: both directions available.
      store.jumpHistory("t1", 1);
      nav = useBrowserStore.getState().navs.t1;
      expect(nav.index).toBe(1);
      expect(nav.url).toBe("http://b/");
      expect(nav.canGoBack).toBe(true);
      expect(nav.canGoForward).toBe(true);
    });

    it("is a no-op for an out-of-range or same target index", () => {
      const store = threeEntryTab();
      store.jumpHistory("t1", -1);
      store.jumpHistory("t1", 3);
      store.jumpHistory("t1", 2); // same as current index
      const nav = useBrowserStore.getState().navs.t1;
      expect(nav.index).toBe(2);
      expect(nav.url).toBe("http://c/");
      expect(nav.history).toEqual(["http://a/", "http://b/", "http://c/"]);
    });

    it("is a no-op for an unknown tab", () => {
      useBrowserStore.getState().jumpHistory("ghost", 0);
      expect(useBrowserStore.getState().navs.ghost).toBeUndefined();
    });

    it("a settled nav event after a multi-step jump updates in place (no corruption)", () => {
      const store = threeEntryTab();
      store.jumpHistory("t1", 0); // optimistic pre-set to index 0
      // The native view settles on the target URL — must hit the in-place branch.
      store.applyNavEvent(navEvent({ tabId: "t1", url: "http://a/", loading: false }));
      const nav = useBrowserStore.getState().navs.t1;
      expect(nav.index).toBe(0);
      expect(nav.url).toBe("http://a/");
      expect(nav.history).toEqual(["http://a/", "http://b/", "http://c/"]);
    });
  });

  describe("suspendTab", () => {
    it("collapses history to the current url and clears back/forward", () => {
      const store = useBrowserStore.getState();
      store.navigate("t1", "http://a/");
      store.navigate("t1", "http://b/");
      store.applyNavEvent(navEvent({ tabId: "t1", url: "http://b/", loading: true }));
      store.suspendTab("t1");
      const nav = useBrowserStore.getState().navs.t1;
      expect(nav.url).toBe("http://b/");
      expect(nav.history).toEqual(["http://b/"]);
      expect(nav.index).toBe(0);
      expect(nav.canGoBack).toBe(false);
      expect(nav.canGoForward).toBe(false);
      expect(nav.loading).toBe(false);
    });

    it("keeps the title intact", () => {
      const store = useBrowserStore.getState();
      store.navigate("t1", "http://a/");
      store.applyNavEvent(navEvent({ tabId: "t1", url: "http://a/", title: "Alpha" }));
      store.suspendTab("t1");
      expect(useBrowserStore.getState().navs.t1.title).toBe("Alpha");
    });

    it("is a no-op for an unknown tab", () => {
      useBrowserStore.getState().suspendTab("ghost");
      expect(useBrowserStore.getState().navs.ghost).toBeUndefined();
    });
  });

  it("removeTab drops nav state", () => {
    const store = useBrowserStore.getState();
    store.navigate("t1", "http://a/");
    store.removeTab("t1");
    expect(useBrowserStore.getState().navs.t1).toBeUndefined();
  });

  it("records visited history when a navigation settles", () => {
    const store = useBrowserStore.getState();
    store.navigate("hist1", "http://a.example/");
    store.applyNavEvent(
      navEvent({ tabId: "hist1", url: "http://a.example/", loading: false, title: "A" }),
    );
    const [top] = useBrowserStore.getState().history;
    expect(top).toMatchObject({ url: "http://a.example/", title: "A", visitCount: 1 });
  });

  it("does not record history while a navigation is still loading", () => {
    const store = useBrowserStore.getState();
    store.navigate("hist2", "http://b.example/");
    store.applyNavEvent(navEvent({ tabId: "hist2", url: "http://b.example/", loading: true }));
    expect(useBrowserStore.getState().history).toHaveLength(0);
  });

  it("recordFavicon attaches a favicon to an existing history entry", () => {
    const store = useBrowserStore.getState();
    store.navigate("hist3", "http://c.example/");
    store.applyNavEvent(navEvent({ tabId: "hist3", url: "http://c.example/", loading: false }));
    store.recordFavicon("http://c.example/", "http://c.example/favicon.ico");
    expect(useBrowserStore.getState().history[0].faviconUrl).toBe("http://c.example/favicon.ico");
  });
});
