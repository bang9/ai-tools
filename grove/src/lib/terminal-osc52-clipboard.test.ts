import { describe, expect, it, vi } from "vitest";
import { parseOsc52, handleOsc52ClipboardRequest } from "./terminal-osc52-clipboard";

const b64 = (text: string): string => Buffer.from(text, "utf-8").toString("base64");

describe("parseOsc52", () => {
  it("decodes a valid clipboard write", () => {
    const result = parseOsc52(`c;${b64("hello")}`);
    expect(result).toEqual({ kind: "write", selections: "c", text: "hello" });
  });

  it("decodes multi-selection prefixes", () => {
    const result = parseOsc52(`cp;${b64("x")}`);
    expect(result).toEqual({ kind: "write", selections: "cp", text: "x" });
  });

  it("decodes utf-8 payloads", () => {
    const result = parseOsc52(`c;${b64("안녕 🌱")}`);
    expect(result).toEqual({ kind: "write", selections: "c", text: "안녕 🌱" });
  });

  it("tolerates whitespace-wrapped base64", () => {
    const raw = b64("wrapped clipboard payload");
    const wrapped = `${raw.slice(0, 4)}\n${raw.slice(4)}`;
    const result = parseOsc52(`c;${wrapped}`);
    expect(result).toEqual({ kind: "write", selections: "c", text: "wrapped clipboard payload" });
  });

  it("classifies the query form", () => {
    expect(parseOsc52("c;?")).toEqual({ kind: "query" });
  });

  it("rejects a missing separator", () => {
    expect(parseOsc52("cnope")).toMatchObject({ kind: "invalid" });
  });

  it("rejects an empty selection list", () => {
    expect(parseOsc52(`;${b64("x")}`)).toMatchObject({ kind: "invalid" });
  });

  it("rejects an unknown selection kind", () => {
    expect(parseOsc52(`z;${b64("x")}`)).toMatchObject({ kind: "invalid" });
  });

  it("rejects a payload over the 128KB cap", () => {
    const huge = "A".repeat(128 * 1024 + 4);
    expect(parseOsc52(`c;${huge}`)).toMatchObject({ kind: "invalid" });
  });

  it("rejects non-base64 payloads", () => {
    expect(parseOsc52("c;*** not base64 ***")).toMatchObject({ kind: "invalid" });
  });
});

describe("handleOsc52ClipboardRequest", () => {
  it("writes decoded text to the clipboard and consumes the sequence", () => {
    const writeClipboardText = vi.fn().mockResolvedValue(undefined);
    const handled = handleOsc52ClipboardRequest(`c;${b64("copy me")}`, { writeClipboardText });
    expect(handled).toBe(true);
    expect(writeClipboardText).toHaveBeenCalledExactlyOnceWith("copy me");
  });

  it("ignores the query form without touching the clipboard", () => {
    const writeClipboardText = vi.fn().mockResolvedValue(undefined);
    const handled = handleOsc52ClipboardRequest("c;?", { writeClipboardText });
    expect(handled).toBe(true);
    expect(writeClipboardText).not.toHaveBeenCalled();
  });

  it("ignores an oversize payload without writing", () => {
    const writeClipboardText = vi.fn().mockResolvedValue(undefined);
    const handled = handleOsc52ClipboardRequest(`c;${"A".repeat(128 * 1024 + 4)}`, {
      writeClipboardText,
    });
    expect(handled).toBe(true);
    expect(writeClipboardText).not.toHaveBeenCalled();
  });

  it("swallows a clipboard-write rejection through onWriteError", async () => {
    const error = new Error("gesture gated");
    const writeClipboardText = vi.fn().mockRejectedValue(error);
    const onWriteError = vi.fn();
    const handled = handleOsc52ClipboardRequest(`c;${b64("x")}`, {
      writeClipboardText,
      onWriteError,
    });
    expect(handled).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(onWriteError).toHaveBeenCalledWith(error);
  });
});
