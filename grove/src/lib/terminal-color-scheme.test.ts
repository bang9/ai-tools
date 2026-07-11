import { describe, expect, it } from "vitest";

import {
  colorSchemeModeForBackground,
  csiParamsIncludeMode2031,
  decideColorSchemeThemePush,
  decideMode2031Csi,
  INITIAL_MODE_2031_STATE,
  mode2031SequenceFor,
  relativeLuminanceFromHex,
  type Mode2031SubscriptionState,
} from "./terminal-color-scheme";

describe("mode2031SequenceFor", () => {
  it("maps modes to the CSI 997 status report bytes", () => {
    expect(mode2031SequenceFor("dark")).toBe("\x1b[?997;1n");
    expect(mode2031SequenceFor("light")).toBe("\x1b[?997;2n");
  });
});

describe("colorSchemeModeForBackground classifier", () => {
  it("classifies pure black and white", () => {
    expect(colorSchemeModeForBackground("#000000")).toBe("dark");
    expect(colorSchemeModeForBackground("#ffffff")).toBe("light");
  });

  it("classifies common terminal backgrounds", () => {
    expect(colorSchemeModeForBackground("#1e1e1e")).toBe("dark");
    expect(colorSchemeModeForBackground("#282c34")).toBe("dark");
    expect(colorSchemeModeForBackground("#fdf6e3")).toBe("light");
  });

  it("flips cleanly across the mid-gray threshold", () => {
    // #808080 -> luminance 128/255 = 0.50196 -> light (>= 0.5)
    expect(colorSchemeModeForBackground("#808080")).toBe("light");
    // #7f7f7f -> luminance 127/255 = 0.49803 -> dark (< 0.5)
    expect(colorSchemeModeForBackground("#7f7f7f")).toBe("dark");
  });

  it("accepts 3-digit and hash-less hex", () => {
    expect(colorSchemeModeForBackground("#000")).toBe("dark");
    expect(colorSchemeModeForBackground("fff")).toBe("light");
    expect(colorSchemeModeForBackground("1e1e1e")).toBe("dark");
  });

  it("defaults malformed or absent hex to dark", () => {
    expect(colorSchemeModeForBackground(null)).toBe("dark");
    expect(colorSchemeModeForBackground(undefined)).toBe("dark");
    expect(colorSchemeModeForBackground("")).toBe("dark");
    expect(colorSchemeModeForBackground("#12")).toBe("dark");
    expect(colorSchemeModeForBackground("#12345")).toBe("dark");
    expect(colorSchemeModeForBackground("#gggggg")).toBe("dark");
    expect(colorSchemeModeForBackground("rgb(255,255,255)")).toBe("dark");
  });
});

describe("relativeLuminanceFromHex", () => {
  it("returns null for malformed hex", () => {
    expect(relativeLuminanceFromHex("#zz")).toBeNull();
    expect(relativeLuminanceFromHex("notacolor")).toBeNull();
    expect(relativeLuminanceFromHex(null)).toBeNull();
  });

  it("returns 0 and 1 for black and white", () => {
    expect(relativeLuminanceFromHex("#000000")).toBe(0);
    expect(relativeLuminanceFromHex("#ffffff")).toBeCloseTo(1, 5);
  });

  it("puts mid-gray just above 0.5", () => {
    expect(relativeLuminanceFromHex("#808080")).toBeCloseTo(128 / 255, 5);
    expect(relativeLuminanceFromHex("#7f7f7f")).toBeCloseTo(127 / 255, 5);
  });
});

describe("csiParamsIncludeMode2031", () => {
  it("detects 2031 in flat and compound params", () => {
    expect(csiParamsIncludeMode2031([2031])).toBe(true);
    expect(csiParamsIncludeMode2031([25, 2031])).toBe(true);
    expect(csiParamsIncludeMode2031([[2031]])).toBe(true);
  });

  it("ignores unrelated private modes", () => {
    expect(csiParamsIncludeMode2031([25])).toBe(false);
    expect(csiParamsIncludeMode2031([1049, 2004])).toBe(false);
    expect(csiParamsIncludeMode2031([])).toBe(false);
  });
});

describe("decideMode2031Csi", () => {
  it("ignores a replay ?2031h before hydration (no bit, no emit)", () => {
    const decision = decideMode2031Csi(INITIAL_MODE_2031_STATE, {
      set: true,
      replaying: true,
      currentMode: "dark",
    });
    expect(decision.emit).toBeNull();
    expect(decision.state).toEqual(INITIAL_MODE_2031_STATE);
    expect(decision.state.subscribed).toBe(false);
  });

  it("seeds the current mode once on a real (hydrated) subscribe", () => {
    const decision = decideMode2031Csi(INITIAL_MODE_2031_STATE, {
      set: true,
      replaying: false,
      currentMode: "dark",
    });
    expect(decision.emit).toBe("\x1b[?997;1n");
    expect(decision.state).toEqual({ subscribed: true, lastPushedMode: "dark" });
  });

  it("seeds light when the current mode is light", () => {
    const decision = decideMode2031Csi(INITIAL_MODE_2031_STATE, {
      set: true,
      replaying: false,
      currentMode: "light",
    });
    expect(decision.emit).toBe("\x1b[?997;2n");
    expect(decision.state.lastPushedMode).toBe("light");
  });

  it("unsubscribes and forgets the last mode on ?2031l", () => {
    const subscribed: Mode2031SubscriptionState = { subscribed: true, lastPushedMode: "dark" };
    const decision = decideMode2031Csi(subscribed, {
      set: false,
      replaying: false,
      currentMode: "dark",
    });
    expect(decision.emit).toBeNull();
    expect(decision.state).toEqual(INITIAL_MODE_2031_STATE);
  });
});

describe("decideColorSchemeThemePush", () => {
  const subscribedDark: Mode2031SubscriptionState = { subscribed: true, lastPushedMode: "dark" };

  it("pushes once when the derived mode flips, then stays quiet on the same mode", () => {
    const flip = decideColorSchemeThemePush(subscribedDark, {
      hydrated: true,
      hasPtyId: true,
      newMode: "light",
    });
    expect(flip.emit).toBe("\x1b[?997;2n");
    expect(flip.state).toEqual({ subscribed: true, lastPushedMode: "light" });

    const again = decideColorSchemeThemePush(flip.state, {
      hydrated: true,
      hasPtyId: true,
      newMode: "light",
    });
    expect(again.emit).toBeNull();
    expect(again.state).toBe(flip.state);
  });

  it("pushes nothing when a theme change keeps the same mode", () => {
    const decision = decideColorSchemeThemePush(subscribedDark, {
      hydrated: true,
      hasPtyId: true,
      newMode: "dark",
    });
    expect(decision.emit).toBeNull();
  });

  it("pushes nothing while unsubscribed", () => {
    const decision = decideColorSchemeThemePush(INITIAL_MODE_2031_STATE, {
      hydrated: true,
      hasPtyId: true,
      newMode: "light",
    });
    expect(decision.emit).toBeNull();
  });

  it("pushes nothing before hydration or without a pty", () => {
    expect(
      decideColorSchemeThemePush(subscribedDark, {
        hydrated: false,
        hasPtyId: true,
        newMode: "light",
      }).emit,
    ).toBeNull();
    expect(
      decideColorSchemeThemePush(subscribedDark, {
        hydrated: true,
        hasPtyId: false,
        newMode: "light",
      }).emit,
    ).toBeNull();
  });
});
