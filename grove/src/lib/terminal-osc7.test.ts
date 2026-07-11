import { describe, expect, it } from "vitest";
import { parseOsc7Cwd } from "./terminal-osc7";

describe("parseOsc7Cwd", () => {
  it("parses an empty-authority file URI to its posix path", () => {
    expect(parseOsc7Cwd("file:///Users/me/project")).toBe("/Users/me/project");
  });

  it("parses a localhost authority to its posix path", () => {
    expect(parseOsc7Cwd("file://localhost/Users/me/src")).toBe("/Users/me/src");
  });

  it("parses an arbitrary hostname authority, discarding the host", () => {
    expect(parseOsc7Cwd("file://somebox/home/me")).toBe("/home/me");
  });

  it("decodes percent-encoded path segments", () => {
    expect(parseOsc7Cwd("file:///Users/me/My%20Code/a%2Bb")).toBe("/Users/me/My Code/a+b");
  });

  it("decodes a percent-encoded unicode directory name", () => {
    expect(parseOsc7Cwd("file:///Users/me/%ED%94%84%EB%A1%9C%EC%A0%9D%ED%8A%B8")).toBe(
      "/Users/me/프로젝트",
    );
  });

  it("rejects a non-file scheme", () => {
    expect(parseOsc7Cwd("http://example.com/path")).toBeNull();
    expect(parseOsc7Cwd("ssh://host/path")).toBeNull();
  });

  it("rejects a payload that is not a file URI at all", () => {
    expect(parseOsc7Cwd("/Users/me/project")).toBeNull();
    expect(parseOsc7Cwd("")).toBeNull();
  });

  it("rejects a file URI with no path", () => {
    expect(parseOsc7Cwd("file://host")).toBeNull();
  });

  it("rejects malformed percent-encoding instead of throwing", () => {
    expect(parseOsc7Cwd("file:///Users/me/%ZZ")).toBeNull();
  });

  it("preserves the root path", () => {
    expect(parseOsc7Cwd("file:///")).toBe("/");
  });
});
