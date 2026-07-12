import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  domBrowserClose,
  domBrowserCloseAll,
  domBrowserCreate,
  findTabIdByWebContentsId,
  registerBrowserHostDom,
} from "./browser-dom-webview";

/**
 * The suite runs in the default node env (the repo has no DOM test environment
 * installed), so `document` is stubbed with the smallest element model this
 * module drives: createElement + appendChild/remove + a style bag.
 */
interface FakeElement {
  tagName: string;
  style: Record<string, string>;
  parentElement: FakeElement | null;
  children: FakeElement[];
  src?: string;
  listeners: Record<string, (() => void)[]>;
  /** Electron guest methods only exist once attached — tests install them by hand. */
  getWebContentsId?: () => number;
  executeJavaScript: (code: string) => Promise<unknown>;
  setAttribute: (name: string, value: string) => void;
  addEventListener: (type: string, handler: () => void) => void;
  appendChild: (child: FakeElement) => FakeElement;
  remove: () => void;
}

function createFakeElement(tagName: string): FakeElement {
  const el: FakeElement = {
    tagName,
    style: {},
    parentElement: null,
    children: [],
    listeners: {},
    executeJavaScript: () => Promise.resolve(),
    setAttribute: () => {},
    addEventListener: (type, handler) => {
      (el.listeners[type] ??= []).push(handler);
    },
    appendChild: (child) => {
      child.parentElement = el;
      el.children.push(child);
      return child;
    },
    remove: () => {
      const parent = el.parentElement;
      if (!parent) return;
      parent.children = parent.children.filter((child) => child !== el);
      el.parentElement = null;
    },
  };
  return el;
}

function asHost(el: FakeElement): HTMLElement {
  return el as unknown as HTMLElement;
}

function guestTags(host: FakeElement): string[] {
  return host.children.map((child) => child.tagName);
}

/** Mount a guest for `tabId` and bring it to `dom-ready` with the given id source. */
function mountReadyGuest(tabId: string, getWebContentsId: () => number): FakeElement {
  const host = createFakeElement("div");
  registerBrowserHostDom(tabId, asHost(host));
  domBrowserCreate(tabId, "http://localhost:3000/");
  const guest = host.children[0];
  guest.getWebContentsId = getWebContentsId;
  for (const handler of guest.listeners["dom-ready"] ?? []) handler();
  return guest;
}

describe("browser-dom-webview", () => {
  beforeEach(() => {
    vi.stubGlobal("document", { createElement: createFakeElement });
  });

  afterEach(() => {
    domBrowserCloseAll();
    vi.unstubAllGlobals();
  });

  it("creates the <webview> once a host and a URL both exist", () => {
    const host = createFakeElement("div");
    registerBrowserHostDom("tab-create", asHost(host));
    expect(guestTags(host)).toEqual([]);

    domBrowserCreate("tab-create", "http://localhost:3000/");

    expect(guestTags(host)).toEqual(["webview"]);
    expect(host.children[0].src).toBe("http://localhost:3000/");
  });

  it("rebuilds the <webview> after an eviction close when the host is re-registered", () => {
    const host = createFakeElement("div");
    registerBrowserHostDom("tab-evict", asHost(host));
    domBrowserCreate("tab-evict", "http://localhost:3000/");
    expect(guestTags(host)).toEqual(["webview"]);

    // Idle eviction closes the guest — this drops the whole registry entry,
    // including the host registration.
    domBrowserClose("tab-evict");
    expect(guestTags(host)).toEqual([]);

    // Returning to the tab: BrowserPanel re-registers the host before
    // recreating, so the guest can mount again instead of coming back blank.
    registerBrowserHostDom("tab-evict", asHost(host));
    domBrowserCreate("tab-evict", "http://localhost:3000/");

    expect(guestTags(host)).toEqual(["webview"]);
    expect(host.children[0].src).toBe("http://localhost:3000/");
  });

  it("stays blank when a closed tab is recreated without re-registering its host", () => {
    const host = createFakeElement("div");
    registerBrowserHostDom("tab-blank", asHost(host));
    domBrowserCreate("tab-blank", "http://localhost:3000/");
    domBrowserClose("tab-blank");

    domBrowserCreate("tab-blank", "http://localhost:3000/");

    expect(guestTags(host)).toEqual([]);
  });

  describe("findTabIdByWebContentsId", () => {
    it("maps a webContents id back to the tab that owns the guest", () => {
      mountReadyGuest("tab-one", () => 11);
      mountReadyGuest("tab-two", () => 22);

      expect(findTabIdByWebContentsId(22)).toBe("tab-two");
      expect(findTabIdByWebContentsId(11)).toBe("tab-one");
    });

    it("returns null for an unknown webContents id", () => {
      mountReadyGuest("tab-one", () => 11);

      expect(findTabIdByWebContentsId(99)).toBeNull();
    });

    it("skips a guest whose getWebContentsId throws", () => {
      mountReadyGuest("tab-throws", () => {
        throw new Error("not attached");
      });
      mountReadyGuest("tab-ok", () => 33);

      expect(findTabIdByWebContentsId(33)).toBe("tab-ok");
      expect(findTabIdByWebContentsId(99)).toBeNull();
    });

    it("maps an attached guest that has not reached dom-ready yet", () => {
      // window.open can fire from an inline <head> script, i.e. before
      // `dom-ready`. Such a popup must still be attributed to its opener tab.
      const host = createFakeElement("div");
      registerBrowserHostDom("tab-pending", asHost(host));
      domBrowserCreate("tab-pending", "http://localhost:3000/");
      host.children[0].getWebContentsId = () => 44;

      expect(findTabIdByWebContentsId(44)).toBe("tab-pending");
    });
  });
});
