import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAnalysisPrompt, analysisSchema } from "../analyzer.js";
import type { Turn } from "../collector.js";

describe("Analyzer", () => {
  describe("buildAnalysisPrompt", () => {
    it("includes turns and cwd", () => {
      const turns: Turn[] = [
        { role: "user", text: "Let's use gRPC", lineNumber: 1 },
        { role: "assistant", text: "Good choice for type safety", lineNumber: 2 },
      ];

      const prompt = buildAnalysisPrompt(turns, "session context", "/home/user/project");
      assert.ok(prompt.includes("[user] Let's use gRPC"));
      assert.ok(prompt.includes("[assistant] Good choice for type safety"));
      assert.ok(prompt.includes("/home/user/project"));
      assert.ok(prompt.includes("session context"));
    });

    it("does not include existing notes section", () => {
      const turns: Turn[] = [
        { role: "user", text: "test", lineNumber: 1 },
      ];

      const prompt = buildAnalysisPrompt(turns, "", "/tmp");
      assert.ok(!prompt.includes("Existing notes"));
      assert.ok(!prompt.includes("duplicates"));
      assert.ok(!prompt.includes("supersession"));
    });
  });

  describe("analysisSchema", () => {
    it("is a valid JSON schema structure", () => {
      assert.equal(analysisSchema.type, "object");
      assert.ok(analysisSchema.properties.notes);
      assert.deepEqual(analysisSchema.required, ["notes"]);
    });

    it("notes schema has required fields", () => {
      const itemSchema = analysisSchema.properties.notes.items;
      assert.deepEqual(itemSchema.required, ["content", "tags", "sources", "type"]);
    });

    it("does not include update or supersede schemas", () => {
      assert.ok(!("notes_to_update" in analysisSchema.properties));
      assert.ok(!("notes_to_supersede" in analysisSchema.properties));
    });
  });
});
