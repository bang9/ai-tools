import { describe, expect, it } from "vitest";
import {
  buildSuggestions,
  findInlineCompletion,
  normalizeHistoryUrl,
  recordFavicon,
  scoreEntry,
  upsertHistory,
  MAX_HISTORY_ENTRIES,
  type BrowserHistoryEntry,
} from "./browser-history";

const NOW = 1_700_000_000_000;

function entry(over: Partial<BrowserHistoryEntry> & { url: string }): BrowserHistoryEntry {
  return {
    normalizedUrl: normalizeHistoryUrl(over.url),
    title: "",
    lastVisitedAt: NOW,
    visitCount: 1,
    ...over,
  };
}

describe("normalizeHistoryUrl", () => {
  it("lowercases scheme+host and trims a single trailing slash", () => {
    expect(normalizeHistoryUrl("HTTP://LocalHost:3000/")).toBe("http://localhost:3000");
    expect(normalizeHistoryUrl("https://Example.com/Docs/")).toBe("https://example.com/docs");
  });

  it("drops the fragment", () => {
    expect(normalizeHistoryUrl("https://example.com/a#section")).toBe("https://example.com/a");
  });

  it("collapses trailing-slash and no-slash roots to the same key", () => {
    expect(normalizeHistoryUrl("http://a.com")).toBe(normalizeHistoryUrl("http://a.com/"));
  });
});

describe("upsertHistory", () => {
  it("prepends a new entry with visitCount 1", () => {
    const next = upsertHistory([], "http://a.com/", "A", NOW, true);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ url: "http://a.com/", title: "A", visitCount: 1 });
  });

  it("merges by normalized url, bumps visit count, moves to front", () => {
    const list = [entry({ url: "http://a.com/", visitCount: 2 }), entry({ url: "http://b.com/" })];
    const next = upsertHistory(list, "http://B.com", "B site", NOW + 1000, true);
    expect(next).toHaveLength(2);
    expect(next[0]).toMatchObject({ url: "http://B.com", title: "B site", visitCount: 2 });
  });

  it("does not bump the count for a follow-up (title/favicon) update", () => {
    const list = [entry({ url: "http://a.com/", title: "", visitCount: 1 })];
    const next = upsertHistory(list, "http://a.com/", "Real Title", NOW + 5, false);
    expect(next[0]).toMatchObject({ title: "Real Title", visitCount: 1 });
  });

  it("keeps the prior title when the update carries none", () => {
    const list = [entry({ url: "http://a.com/", title: "Kept" })];
    const next = upsertHistory(list, "http://a.com/", "", NOW + 5, false);
    expect(next[0].title).toBe("Kept");
  });

  it("skips blank urls", () => {
    expect(upsertHistory([], "about:blank", "", NOW, true)).toEqual([]);
    expect(upsertHistory([], "   ", "", NOW, true)).toEqual([]);
  });

  it("caps the list, evicting the least-recently-visited", () => {
    const full = Array.from({ length: MAX_HISTORY_ENTRIES }, (_, i) =>
      entry({ url: `http://u${i}.com/`, lastVisitedAt: NOW + i }),
    );
    const next = upsertHistory(full, "http://new.com/", "", NOW + 10_000, true);
    expect(next).toHaveLength(MAX_HISTORY_ENTRIES);
    expect(next[0].url).toBe("http://new.com/");
    // u0 was the oldest → evicted.
    expect(next.some((e) => e.url === "http://u0.com/")).toBe(false);
  });
});

describe("scoreEntry", () => {
  it("returns -1 when the query matches neither url nor title", () => {
    expect(scoreEntry(entry({ url: "http://a.com/", title: "Alpha" }), "zzz", NOW)).toBe(-1);
  });

  it("adds a prefix boost for a scheme-stripped prefix match", () => {
    const prefixed = scoreEntry(entry({ url: "http://localhost:3000/" }), "local", NOW);
    const mid = scoreEntry(entry({ url: "http://x.com/localpath" }), "local", NOW);
    expect(prefixed).toBeGreaterThan(mid);
  });

  it("matches on the title too", () => {
    expect(
      scoreEntry(entry({ url: "http://a.com/", title: "Grafana" }), "grafana", NOW),
    ).toBeGreaterThanOrEqual(0);
  });
});

describe("buildSuggestions", () => {
  const list = [
    entry({ url: "http://localhost:3000/", visitCount: 1, lastVisitedAt: NOW - 1000 }),
    entry({ url: "http://localhost:5173/", visitCount: 9, lastVisitedAt: NOW - 2000 }),
    entry({ url: "https://example.com/docs", title: "Docs", lastVisitedAt: NOW }),
  ];

  it("returns most-recent entries for an empty query", () => {
    expect(buildSuggestions(list, "", NOW).map((e) => e.url)).toEqual([
      "https://example.com/docs",
      "http://localhost:3000/",
      "http://localhost:5173/",
    ]);
  });

  it("ranks frecency: more visits wins among equal prefix matches", () => {
    const ranked = buildSuggestions(list, "localhost", NOW).map((e) => e.url);
    expect(ranked[0]).toBe("http://localhost:5173/"); // visitCount 9 > 1
  });

  it("filters out non-matches and matches title", () => {
    expect(buildSuggestions(list, "docs", NOW).map((e) => e.url)).toEqual([
      "https://example.com/docs",
    ]);
  });

  it("respects the limit", () => {
    expect(buildSuggestions(list, "", NOW, 1)).toHaveLength(1);
  });
});

describe("findInlineCompletion", () => {
  const list = [
    entry({ url: "http://localhost:3000/", visitCount: 1 }),
    entry({ url: "http://localhost:5173/", visitCount: 5 }),
    entry({ url: "https://example.com/docs" }),
  ];

  it("completes from a scheme-stripped prefix", () => {
    expect(findInlineCompletion(list, "example", NOW)).toEqual({
      url: "https://example.com/docs",
      completion: ".com/docs",
    });
  });

  it("prefers the higher-frecency match among prefix matches", () => {
    // Both start with "localhost"; the 5173 entry has more visits → wins.
    expect(findInlineCompletion(list, "local", NOW)).toEqual({
      url: "http://localhost:5173/",
      completion: "host:5173/",
    });
  });

  it("matches when the typed text includes a scheme", () => {
    expect(findInlineCompletion(list, "http://localhost:3", NOW)).toEqual({
      url: "http://localhost:3000/",
      completion: "000/",
    });
  });

  it("keeps the entry's casing in the remainder for a case-insensitive match", () => {
    expect(
      findInlineCompletion([entry({ url: "https://Example.com/Docs" })], "example", NOW),
    ).toEqual({
      url: "https://Example.com/Docs",
      completion: ".com/Docs",
    });
  });

  it("returns null for empty input, no match, or an exact full entry", () => {
    expect(findInlineCompletion(list, "", NOW)).toBeNull();
    expect(findInlineCompletion(list, "zzz", NOW)).toBeNull();
    expect(findInlineCompletion(list, "localhost:3000/", NOW)).toBeNull();
  });
});

describe("recordFavicon", () => {
  it("attaches a favicon to the matching entry", () => {
    const list = [entry({ url: "http://a.com/" })];
    const next = recordFavicon(list, "http://A.com", "http://a.com/favicon.ico");
    expect(next[0].faviconUrl).toBe("http://a.com/favicon.ico");
  });

  it("returns the same reference when nothing changes", () => {
    const list = [entry({ url: "http://a.com/", faviconUrl: "http://a.com/favicon.ico" })];
    expect(recordFavicon(list, "http://a.com/", "http://a.com/favicon.ico")).toBe(list);
    expect(recordFavicon(list, "http://other.com/", "x")).toBe(list);
  });
});
