import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAnalysisPrompt, analysisSchema } from "../analyzer.js";
import type { Turn } from "../collector.js";
import type { NoteSummary } from "../types.js";

describe("Analyzer", () => {
  describe("buildAnalysisPrompt", () => {
    it("includes turns and cwd", () => {
      const turns: Turn[] = [
        { role: "user", text: "Let's use gRPC", lineNumber: 1 },
        { role: "assistant", text: "Good choice for type safety", lineNumber: 2 },
      ];

      const prompt = buildAnalysisPrompt(turns, "session context", [], "/home/user/project");
      assert.ok(prompt.includes("[user] Let's use gRPC"));
      assert.ok(prompt.includes("[assistant] Good choice for type safety"));
      assert.ok(prompt.includes("/home/user/project"));
      assert.ok(prompt.includes("session context"));
    });

    it("includes existing notes for dedup", () => {
      const turns: Turn[] = [
        { role: "user", text: "test", lineNumber: 1 },
      ];
      const existing: NoteSummary[] = [
        { id: "abc123", preview: "gRPC chosen for safety", type: "decision", tags: ["arch"], status: "open" },
      ];

      const prompt = buildAnalysisPrompt(turns, "", existing, "/tmp");
      assert.ok(prompt.includes("abc123"));
      assert.ok(prompt.includes("gRPC chosen for safety"));
      assert.ok(prompt.includes("decision"));
    });

    it("handles empty existing notes", () => {
      const turns: Turn[] = [
        { role: "user", text: "hello", lineNumber: 1 },
      ];

      const prompt = buildAnalysisPrompt(turns, "", [], "/tmp");
      assert.ok(!prompt.includes("Existing notes"));
    });
  });

  describe("analysisSchema", () => {
    it("is a valid JSON schema structure", () => {
      assert.equal(analysisSchema.type, "object");
      assert.ok(analysisSchema.properties.notes_to_add);
      assert.ok(analysisSchema.properties.notes_to_update);
      assert.ok(analysisSchema.properties.notes_to_supersede);
      assert.deepEqual(analysisSchema.required, ["notes_to_add", "notes_to_update", "notes_to_supersede"]);
    });

    it("notes_to_add schema has required fields", () => {
      const itemSchema = analysisSchema.properties.notes_to_add.items;
      assert.deepEqual(itemSchema.required, ["content", "tags", "sources", "status"]);
    });

    it("notes_to_update schema has required fields", () => {
      const itemSchema = analysisSchema.properties.notes_to_update.items;
      assert.deepEqual(itemSchema.required, ["id", "changes"]);
    });
  });
});
