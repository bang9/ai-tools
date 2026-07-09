import { describe, expect, it } from "vitest";
import {
  filterUrlSuggestions,
  findUrlCompletion,
  pushRecentUrl,
  MAX_RECENT_URLS,
} from "./browser-history";

describe("pushRecentUrl", () => {
  it("prepends new urls", () => {
    expect(pushRecentUrl(["http://a/"], "http://b/")).toEqual([
      "http://b/",
      "http://a/",
    ]);
  });

  it("moves an existing url to the front", () => {
    expect(pushRecentUrl(["http://a/", "http://b/"], "http://b/")).toEqual([
      "http://b/",
      "http://a/",
    ]);
  });

  it("caps the list length", () => {
    const full = Array.from({ length: MAX_RECENT_URLS }, (_, i) => `http://u${i}/`);
    const next = pushRecentUrl(full, "http://new/");
    expect(next).toHaveLength(MAX_RECENT_URLS);
    expect(next[0]).toBe("http://new/");
    expect(next).not.toContain(`http://u${MAX_RECENT_URLS - 1}/`);
  });
});

describe("filterUrlSuggestions", () => {
  const list = [
    "http://localhost:3000/",
    "http://localhost:5173/",
    "https://example.com/docs",
  ];

  it("returns all (up to limit) for an empty query", () => {
    expect(filterUrlSuggestions(list, "")).toEqual(list);
  });

  it("matches substrings case-insensitively", () => {
    expect(filterUrlSuggestions(list, "EXAMPLE")).toEqual([
      "https://example.com/docs",
    ]);
    expect(filterUrlSuggestions(list, "localhost")).toEqual([
      "http://localhost:3000/",
      "http://localhost:5173/",
    ]);
  });

  it("respects the limit", () => {
    expect(filterUrlSuggestions(list, "", 1)).toEqual(["http://localhost:3000/"]);
  });

  it("returns empty when nothing matches", () => {
    expect(filterUrlSuggestions(list, "nope")).toEqual([]);
  });
});

describe("findUrlCompletion", () => {
  const list = [
    "http://localhost:3000/",
    "http://localhost:5173/",
    "https://example.com/docs",
  ];

  it("completes from a scheme-stripped prefix", () => {
    expect(findUrlCompletion(list, "loc")).toEqual({
      url: "http://localhost:3000/",
      completion: "alhost:3000/",
    });
  });

  it("completes an https entry to the real url while displaying scheme-stripped", () => {
    expect(findUrlCompletion(list, "example")).toEqual({
      url: "https://example.com/docs",
      completion: ".com/docs",
    });
  });

  it("prefers the most-recent match (MRU order)", () => {
    expect(findUrlCompletion(["http://localhost:5173/", "http://localhost:3000/"], "local")).toEqual({
      url: "http://localhost:5173/",
      completion: "host:5173/",
    });
  });

  it("matches case-insensitively but keeps the entry's casing in the remainder", () => {
    expect(findUrlCompletion(list, "LOCAL")).toEqual({
      url: "http://localhost:3000/",
      completion: "host:3000/",
    });
  });

  it("matches when the typed text includes a scheme", () => {
    expect(findUrlCompletion(list, "http://loc")).toEqual({
      url: "http://localhost:3000/",
      completion: "alhost:3000/",
    });
  });

  it("returns null for empty input", () => {
    expect(findUrlCompletion(list, "")).toBeNull();
  });

  it("returns null when nothing prefix-matches", () => {
    expect(findUrlCompletion(list, "zzz")).toBeNull();
  });

  it("returns null when the typed text already equals a full entry (nothing to complete)", () => {
    expect(findUrlCompletion(list, "localhost:3000/")).toBeNull();
  });
});
