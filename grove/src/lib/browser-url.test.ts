import { describe, expect, it } from "vitest";
import { normalizeBrowserUrl, browserTabTitle } from "./browser-url";

describe("normalizeBrowserUrl", () => {
  it("prefixes bare hosts with http://", () => {
    expect(normalizeBrowserUrl("localhost:3000")).toBe("http://localhost:3000/");
    expect(normalizeBrowserUrl("example.com/path")).toBe("http://example.com/path");
  });

  it("keeps explicit schemes", () => {
    expect(normalizeBrowserUrl("https://example.com")).toBe("https://example.com/");
    expect(normalizeBrowserUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080/");
  });

  it("trims whitespace", () => {
    expect(normalizeBrowserUrl("  localhost:5173  ")).toBe("http://localhost:5173/");
  });

  it("rejects empty and invalid input", () => {
    expect(normalizeBrowserUrl("")).toBeNull();
    expect(normalizeBrowserUrl("   ")).toBeNull();
    expect(normalizeBrowserUrl("http://")).toBeNull();
  });

  it("accepts file URLs with a path", () => {
    expect(normalizeBrowserUrl("file:///Users/me/index.html")).toBe("file:///Users/me/index.html");
    expect(normalizeBrowserUrl("file://")).toBeNull();
  });

  it("rejects other non-http(s) schemes", () => {
    expect(normalizeBrowserUrl("javascript://alert(1)")).toBeNull();
  });
});

describe("browserTabTitle", () => {
  it("returns host with port", () => {
    expect(browserTabTitle("http://localhost:3000/")).toBe("localhost:3000");
    expect(browserTabTitle("https://example.com/deep/path")).toBe("example.com");
  });

  it("returns the file name for file URLs", () => {
    expect(browserTabTitle("file:///Users/me/pages/index.html")).toBe("index.html");
    expect(browserTabTitle("file:///Users/me/my%20page.html")).toBe("my page.html");
  });

  it("falls back to Browser for unparseable input", () => {
    expect(browserTabTitle("not a url")).toBe("Browser");
  });
});
