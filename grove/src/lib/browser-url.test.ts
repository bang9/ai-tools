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

  it("rejects non-http(s) schemes", () => {
    expect(normalizeBrowserUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeBrowserUrl("javascript://alert(1)")).toBeNull();
  });
});

describe("browserTabTitle", () => {
  it("returns host with port", () => {
    expect(browserTabTitle("http://localhost:3000/")).toBe("localhost:3000");
    expect(browserTabTitle("https://example.com/deep/path")).toBe("example.com");
  });

  it("falls back to Browser for unparseable input", () => {
    expect(browserTabTitle("not a url")).toBe("Browser");
  });
});
