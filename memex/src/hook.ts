import { Store } from "./store.js";
import { extractNewTurns, readCursor, writeCursor, totalLines, buildSessionSummary } from "./collector.js";
import { analyzeSession } from "./analyzer.js";
import { computeEmbedding, routeByEmbedding } from "./embedder.js";
import type { NoteCandidate, Source } from "./types.js";

interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
}

async function main(): Promise<void> {
  // Read stdin (hook input JSON)
  const input = await readStdin();
  if (!input) {
    process.exit(0);
  }

  let hookInput: HookInput;
  try {
    hookInput = JSON.parse(input);
  } catch {
    console.error("hook: failed to parse stdin JSON");
    process.exit(0);
  }

  const { session_id, transcript_path, cwd } = hookInput;
  if (!session_id || !transcript_path) {
    console.error("hook: missing session_id or transcript_path");
    process.exit(0);
  }

  const store = new Store();
  const cfg = store.getConfig();

  // Read cursor for this session
  const cursor = readCursor(store.getBaseDir(), session_id);
  const total = totalLines(transcript_path);

  // Extract new turns since last cursor
  const newTurns = extractNewTurns(transcript_path, cursor);
  const userAssistantTurns = newTurns.filter((t) => t.role === "user" || t.role === "assistant");

  if (userAssistantTurns.length === 0) {
    // No new turns — update cursor and exit
    writeCursor(store.getBaseDir(), session_id, total);
    process.exit(0);
  }

  // Build session summary for context
  const sessionSummary = buildSessionSummary(transcript_path, 50);

  // Run analysis (no existing notes needed — embedding handles routing)
  const result = await analyzeSession(
    userAssistantTurns,
    sessionSummary,
    cwd,
    cfg.auth_token,
    cfg.api_key,
    cfg.model,
  );

  // Apply results via embedding-based routing
  for (const candidate of result.notes) {
    await applyCandidate(store, candidate, cfg.embedding_enabled);
  }

  // Update cursor
  writeCursor(store.getBaseDir(), session_id, total);
}

async function applyCandidate(
  store: Store,
  candidate: NoteCandidate,
  embeddingEnabled: boolean,
): Promise<void> {
  if (!embeddingEnabled) {
    // Fallback: add all candidates independently (no dedup)
    const id = store.add({
      content: candidate.content,
      type: candidate.type,
      tags: candidate.tags,
      sources: candidate.sources,
    });
    console.error(`hook: added note ${id} (embedding disabled)`);
    return;
  }

  const embedding = await computeEmbedding(candidate.content);
  const existingEmbeddings = store.allEmbeddings();
  const decision = routeByEmbedding(embedding, existingEmbeddings);

  switch (decision.action) {
    case "supersede": {
      // Mark existing as superseded, add new note with supersedes relation
      store.updateStatus(decision.existingId, "superseded");
      const id = store.add({
        content: candidate.content,
        type: candidate.type,
        tags: candidate.tags,
        sources: candidate.sources,
        relations: [{ target_id: decision.existingId, type: "supersedes" }],
      });
      store.setEmbedding(id, embedding);
      console.error(`hook: superseded ${decision.existingId} → added ${id} (sim=${decision.similarity.toFixed(3)})`);
      break;
    }

    case "update": {
      // Update existing note: replace content, merge tags/sources
      const existing = store.get(decision.existingId);
      const mergedTags = [...new Set([...existing.tags, ...candidate.tags])];
      const mergedSources = mergeSources(existing.sources, candidate.sources);
      store.update(decision.existingId, {
        content: candidate.content,
        tags: mergedTags,
        sources: mergedSources,
      });
      store.setEmbedding(decision.existingId, embedding);
      console.error(`hook: updated ${decision.existingId} (sim=${decision.similarity.toFixed(3)})`);
      break;
    }

    case "add_related": {
      // Add new note with relates_to relation
      const id = store.add({
        content: candidate.content,
        type: candidate.type,
        tags: candidate.tags,
        sources: candidate.sources,
        relations: [{ target_id: decision.existingId, type: "relates_to" }],
      });
      store.setEmbedding(id, embedding);
      console.error(`hook: added ${id} related to ${decision.existingId} (sim=${decision.similarity.toFixed(3)})`);
      break;
    }

    case "add_independent": {
      const id = store.add({
        content: candidate.content,
        type: candidate.type,
        tags: candidate.tags,
        sources: candidate.sources,
      });
      store.setEmbedding(id, embedding);
      console.error(`hook: added ${id} (independent)`);
      break;
    }
  }
}

function mergeSources(existing: Source[], incoming: Source[]): Source[] {
  const keys = new Set(existing.map((s) => `${s.project}:${s.path}`));
  const merged = [...existing];
  for (const src of incoming) {
    const key = `${src.project}:${src.path}`;
    if (!keys.has(key)) {
      merged.push(src);
      keys.add(key);
    }
  }
  return merged;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data.trim()));
    // Timeout: if no stdin within 5s, resolve empty
    setTimeout(() => resolve(data.trim()), 5000);
  });
}

main().catch((err) => {
  console.error("hook: unhandled error:", err);
  process.exit(0); // Always exit 0 — async hook errors shouldn't block
});
