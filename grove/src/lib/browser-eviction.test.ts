import { describe, expect, it } from "vitest";
import {
  DEFAULT_EVICTION_LIMITS,
  EVICTION_MAX_ALIVE,
  EVICTION_TTL_MS,
  selectEvictions,
  type WebviewVisibility,
} from "./browser-eviction";

function hidden(hiddenSince: number): WebviewVisibility {
  return { visible: false, hiddenSince };
}
const visible: WebviewVisibility = { visible: true, hiddenSince: null };

const LIMITS = { ttlMs: 1000, maxAlive: 3 };

describe("selectEvictions", () => {
  it("exposes sane default constants", () => {
    expect(EVICTION_TTL_MS).toBe(10 * 60 * 1000);
    expect(EVICTION_MAX_ALIVE).toBe(5);
    expect(DEFAULT_EVICTION_LIMITS).toEqual({
      ttlMs: EVICTION_TTL_MS,
      maxAlive: EVICTION_MAX_ALIVE,
    });
  });

  it("evicts nothing when under limits and within TTL", () => {
    const records = { a: visible, b: hidden(900) };
    expect(selectEvictions(records, 1000, LIMITS)).toEqual([]);
  });

  it("evicts a webview hidden longer than the TTL", () => {
    const records = { a: visible, b: hidden(0) };
    // now - hiddenSince = 1001 > 1000
    expect(selectEvictions(records, 1001, LIMITS)).toEqual(["b"]);
  });

  it("does not evict at exactly the TTL boundary (strictly greater)", () => {
    const records = { a: hidden(0) };
    expect(selectEvictions(records, 1000, LIMITS)).toEqual([]);
  });

  it("never evicts a visible webview even when hidden past TTL", () => {
    const records = { a: visible, b: visible, c: hidden(0) };
    expect(selectEvictions(records, 5000, LIMITS)).toEqual(["c"]);
  });

  it("caps alive count by evicting least-recently-visible hidden first", () => {
    // 5 alive, cap 3 -> evict 2 hidden, oldest hiddenSince first.
    const records = {
      v1: visible,
      h_new: hidden(500),
      h_old: hidden(100),
      h_mid: hidden(300),
      v2: visible,
    };
    const result = selectEvictions(records, 600, LIMITS);
    expect(result.sort()).toEqual(["h_mid", "h_old"]);
  });

  it("never evicts visible webviews to satisfy the cap", () => {
    // 4 visible + 1 hidden, cap 3. Only the hidden one may go, leaving 4 alive.
    const records = {
      v1: visible,
      v2: visible,
      v3: visible,
      v4: visible,
      h1: hidden(100),
    };
    expect(selectEvictions(records, 200, LIMITS)).toEqual(["h1"]);
  });

  it("does not double-count a TTL victim toward the cap", () => {
    // 5 alive, cap 3. One is past TTL; only one more needed for the cap.
    const records = {
      v1: visible,
      v2: visible,
      h_expired: hidden(0),
      h_a: hidden(600),
      h_b: hidden(700),
    };
    // now=1500, ttl=1000: only h_expired (1500 > 1000) is a TTL victim; h_a
    // (900) and h_b (800) are within TTL. alive after TTL = 4, cap = 3, so one
    // more must go -> least-recently-visible remaining hidden is h_a(600).
    const result = selectEvictions(records, 1500, LIMITS);
    expect(result.sort()).toEqual(["h_a", "h_expired"]);
  });

  it("ignores hidden records with an unknown hiddenSince", () => {
    const records: Record<string, WebviewVisibility> = {
      a: { visible: false, hiddenSince: null },
    };
    expect(selectEvictions(records, 999999, LIMITS)).toEqual([]);
  });
});
