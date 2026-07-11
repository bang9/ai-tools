import { describe, expect, it } from "vitest";
import {
  normalizeBrowserUrl,
  browserTabTitle,
  buildSearchUrl,
  looksLikeSearchQuery,
  resolveAddressInput,
  urlSecurity,
} from "./browser-url";

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

describe("looksLikeSearchQuery", () => {
  it("treats whitespace-bearing input as a search", () => {
    expect(looksLikeSearchQuery("hello world")).toBe(true);
    expect(looksLikeSearchQuery("how to center a div")).toBe(true);
  });

  it("treats a single bare word as a search", () => {
    expect(looksLikeSearchQuery("weather")).toBe(true);
  });

  it("treats hosts, ports, schemes and dotted names as URLs", () => {
    expect(looksLikeSearchQuery("example.com")).toBe(false);
    expect(looksLikeSearchQuery("example.com/path")).toBe(false);
    expect(looksLikeSearchQuery("localhost:3000")).toBe(false);
    expect(looksLikeSearchQuery("https://example.com")).toBe(false);
    expect(looksLikeSearchQuery("192.168.0.1")).toBe(false);
  });
});

describe("buildSearchUrl", () => {
  it("builds a google query URL by default, encoding the query", () => {
    expect(buildSearchUrl("a b&c")).toBe("https://www.google.com/search?q=a%20b%26c");
  });

  it("supports other engines", () => {
    expect(buildSearchUrl("x", "duckduckgo")).toBe("https://duckduckgo.com/?q=x");
    expect(buildSearchUrl("x", "bing")).toBe("https://www.bing.com/search?q=x");
  });
});

describe("resolveAddressInput", () => {
  it("navigates URLs and bare hosts", () => {
    expect(resolveAddressInput("example.com")).toBe("http://example.com/");
    expect(resolveAddressInput("localhost:3000")).toBe("http://localhost:3000/");
    expect(resolveAddressInput("https://a.com")).toBe("https://a.com/");
  });

  it("searches non-URL queries", () => {
    expect(resolveAddressInput("hello world")).toBe(
      "https://www.google.com/search?q=hello%20world",
    );
    expect(resolveAddressInput("weather")).toBe("https://www.google.com/search?q=weather");
  });

  it("returns null only for empty input", () => {
    expect(resolveAddressInput("   ")).toBeNull();
  });
});

describe("urlSecurity", () => {
  it("classifies transport", () => {
    expect(urlSecurity("https://a.com")).toBe("secure");
    expect(urlSecurity("http://a.com")).toBe("insecure");
    expect(urlSecurity("file:///x.html")).toBe("file");
    expect(urlSecurity(null)).toBe("none");
    expect(urlSecurity("not a url")).toBe("none");
  });
});
