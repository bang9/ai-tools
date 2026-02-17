import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { extractNewTurns, readCursor, writeCursor, totalLines, buildSessionSummary } from "../collector.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "memex-collector-"));
}

function makeTranscript(lines: object[]): string {
  const dir = tmpDir();
  const path = join(dir, "transcript.jsonl");
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"));
  return path;
}

describe("Collector", () => {
  it("extracts user and assistant turns", () => {
    const path = makeTranscript([
      { type: "user", isSidechain: false, message: { role: "user", content: "hello" } },
      { type: "assistant", isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: "hi there" }] } },
      { type: "progress", isSidechain: false, data: {} },
      { type: "user", isSidechain: false, message: { role: "user", content: "bye" } },
    ]);

    const turns = extractNewTurns(path, 0);
    assert.equal(turns.length, 3);
    assert.equal(turns[0].role, "user");
    assert.equal(turns[0].text, "hello");
    assert.equal(turns[1].role, "assistant");
    assert.equal(turns[1].text, "hi there");
    assert.equal(turns[2].role, "user");
    assert.equal(turns[2].text, "bye");
  });

  it("skips sidechains", () => {
    const path = makeTranscript([
      { type: "user", isSidechain: false, message: { role: "user", content: "main chain" } },
      { type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "sidechain" }] } },
      { type: "user", isSidechain: false, message: { role: "user", content: "still main" } },
    ]);

    const turns = extractNewTurns(path, 0);
    assert.equal(turns.length, 2);
    assert.equal(turns[0].text, "main chain");
    assert.equal(turns[1].text, "still main");
  });

  it("extracts text only from assistant (skips thinking/tool_use)", () => {
    const path = makeTranscript([
      {
        type: "assistant", isSidechain: false, message: {
          role: "assistant", content: [
            { type: "thinking", thinking: "internal thought" },
            { type: "text", text: "visible response" },
            { type: "tool_use", name: "Read", input: {} },
          ],
        },
      },
    ]);

    const turns = extractNewTurns(path, 0);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].text, "visible response");
  });

  it("respects cursor position", () => {
    const path = makeTranscript([
      { type: "user", isSidechain: false, message: { role: "user", content: "first" } },
      { type: "user", isSidechain: false, message: { role: "user", content: "second" } },
      { type: "user", isSidechain: false, message: { role: "user", content: "third" } },
    ]);

    const turns = extractNewTurns(path, 2);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].text, "third");
  });

  it("returns empty for nonexistent file", () => {
    const turns = extractNewTurns("/nonexistent/path.jsonl", 0);
    assert.equal(turns.length, 0);
  });

  it("totalLines counts correctly", () => {
    const path = makeTranscript([
      { type: "user", isSidechain: false, message: { role: "user", content: "a" } },
      { type: "user", isSidechain: false, message: { role: "user", content: "b" } },
    ]);
    assert.equal(totalLines(path), 2);
  });

  it("cursor read/write", () => {
    const dir = tmpDir();
    mkdirSync(join(dir, "sessions"), { recursive: true });

    assert.equal(readCursor(dir, "test-session"), 0);
    writeCursor(dir, "test-session", 42);
    assert.equal(readCursor(dir, "test-session"), 42);
    writeCursor(dir, "test-session", 100);
    assert.equal(readCursor(dir, "test-session"), 100);
  });

  it("buildSessionSummary", () => {
    const path = makeTranscript([
      { type: "user", isSidechain: false, message: { role: "user", content: "hello" } },
      { type: "assistant", isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
    ]);

    const summary = buildSessionSummary(path, 10);
    assert.ok(summary.includes("[user] hello"));
    assert.ok(summary.includes("[assistant] hi"));
  });

  it("handles user content as array", () => {
    const path = makeTranscript([
      {
        type: "user", isSidechain: false, message: {
          role: "user", content: [
            { type: "text", text: "part1" },
            { type: "text", text: "part2" },
          ],
        },
      },
    ]);

    const turns = extractNewTurns(path, 0);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].text, "part1\npart2");
  });
});
