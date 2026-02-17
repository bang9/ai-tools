import type { Note, Relation, EnrichmentResult } from "./types.js";
import { sourceKey } from "./types.js";
import { Store } from "./store.js";
import { cosineSimilarity } from "./search.js";

export interface LLMClient {
  analyze(note: Note, candidates: Note[]): Promise<EnrichmentResult>;
}

export class Enricher {
  private queue: string[] = [];
  private processing = false;
  private store: Store;
  private client: LLMClient | null;

  constructor(store: Store, client: LLMClient | null) {
    this.store = store;
    this.client = client;
  }

  enqueue(id: string): void {
    if (!this.client) return;
    this.queue.push(id);
    this.processNext();
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const id = this.queue.shift()!;
      try {
        await this.processNote(id);
      } catch (err) {
        console.error(`enricher: failed to process note ${id}:`, err);
      }
    }

    this.processing = false;
  }

  private async processNote(id: string): Promise<void> {
    const note = this.store.get(id);
    const candidates = this.findCandidates(note, 20);
    if (candidates.length === 0) return;

    const result = await this.client!.analyze(note, candidates);

    if (result.relations.length > 0) {
      this.store.addRelations(id, result.relations);
    }

    for (const sid of result.superseded ?? []) {
      try {
        this.store.updateStatus(sid, "superseded");
      } catch (err) {
        console.error(`enricher: failed to mark ${sid} as superseded:`, err);
      }
    }
  }

  private findCandidates(note: Note, k: number): Note[] {
    const scores = new Map<string, number>();
    const tags = this.store.tagsIndex();
    const sources = this.store.sourcesIndex();

    // Tag overlap
    for (const tag of note.tags) {
      for (const id of tags[tag] ?? []) {
        if (id !== note.id) scores.set(id, (scores.get(id) ?? 0) + 2);
      }
    }

    // Source overlap
    for (const src of note.sources) {
      const key = sourceKey(src);
      for (const [skey, ids] of Object.entries(sources)) {
        if (skey.startsWith(key) || key.startsWith(skey)) {
          for (const id of ids) {
            if (id !== note.id) scores.set(id, (scores.get(id) ?? 0) + 3);
          }
        }
      }
    }

    // Embedding similarity
    const noteEmb = this.store.getEmbedding(note.id);
    if (noteEmb) {
      for (const [id, emb] of Object.entries(this.store.allEmbeddings())) {
        if (id !== note.id) {
          const sim = cosineSimilarity(noteEmb, emb);
          if (sim > 0.3) scores.set(id, (scores.get(id) ?? 0) + sim * 5);
        }
      }
    }

    // Sort and take top-k
    const ranked = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, k);

    return ranked
      .map(([id]) => { try { return this.store.get(id); } catch { return null; } })
      .filter((n): n is Note => n !== null);
  }
}

// --- Agent SDK Client ---

export class AgentSDKClient implements LLMClient {
  async analyze(note: Note, candidates: Note[]): Promise<EnrichmentResult> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const prompt = buildEnrichmentPrompt(note, candidates);

    // Strip CLAUDECODE env to avoid "nested session" error when
    // the MCP server (spawned by Claude Code) calls the Agent SDK.
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.CLAUDECODE;

    let resultText = "";
    for await (const message of query({
      prompt,
      options: {
        allowedTools: [],
        maxTurns: 1,
        tools: [],
        model: "claude-haiku-4-5-20251001",
        effort: "low" as const,
        persistSession: false,
        env,
      },
    })) {
      const msg = message as any;
      // Collect assistant text
      if (msg.type === "assistant" && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === "text") resultText += block.text;
        }
      }
      // Also check for result message
      if ("result" in msg && typeof msg.result === "string") {
        resultText = msg.result;
      }
    }

    if (!resultText) return { relations: [], superseded: [] };

    const json = extractJSON(resultText);
    try {
      return JSON.parse(json);
    } catch {
      console.error("enricher: failed to parse result:", resultText);
      return { relations: [], superseded: [] };
    }
  }
}

function buildEnrichmentPrompt(note: Note, candidates: Note[]): string {
  let prompt = "Analyze the NEW note below and find relationships to EXISTING notes.\n\n";
  prompt += `NEW NOTE:\nID: ${note.id}\nType: ${note.type}\nContent: ${note.content}\nTags: ${note.tags.join(", ")}\n\n`;
  prompt += "EXISTING NOTES:\n";
  for (const c of candidates) {
    prompt += `- ID: ${c.id} | Type: ${c.type} | Status: ${c.status} | Content: ${c.content}\n`;
  }
  prompt += `
Respond with ONLY a JSON object (no markdown, no explanation):
{
  "relations": [
    {"target_id": "<existing_note_id>", "type": "<relation_type>"}
  ],
  "superseded": ["<note_id_that_new_note_supersedes>"]
}

Relation types: relates_to, depends_on, contradicts, supersedes, elaborates, blocks
Rules:
- Only include relations with high confidence
- "superseded" lists IDs of existing notes that the new note completely replaces
- If no relations found, return {"relations": [], "superseded": []}
- target_id in relations must reference existing note IDs only
`;
  return prompt;
}

function extractJSON(text: string): string {
  // Try markdown code block
  let match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) return match[1].trim();

  // Try raw JSON
  const start = text.indexOf("{");
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") { depth--; if (depth === 0) return text.slice(start, i + 1); }
    }
  }
  return text;
}
