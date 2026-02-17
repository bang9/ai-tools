import { Store } from "./store.js";
import { extractNewTurns, readCursor, writeCursor, totalLines, buildSessionSummary } from "./collector.js";
import { analyzeSession } from "./analyzer.js";

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

  // Check minimum turns threshold
  const minTurns = cfg.hook_min_turns ?? 3;
  if (userAssistantTurns.length < minTurns) {
    // Not enough new turns — update cursor and exit
    writeCursor(store.getBaseDir(), session_id, total);
    process.exit(0);
  }

  // Build session summary for context
  const sessionSummary = buildSessionSummary(transcript_path, 50);

  // Get existing notes for dedup/supersession
  const existingNotes = store.list();

  // Run analysis
  const result = await analyzeSession(
    userAssistantTurns,
    sessionSummary,
    existingNotes,
    cwd,
    cfg.auth_token,
    cfg.api_key,
    cfg.model,
  );

  // Apply results
  for (const note of result.notes_to_add) {
    const id = store.add({
      content: note.content,
      tags: note.tags,
      sources: note.sources,
      status: note.status || "open",
    });
    console.error(`hook: added note ${id}`);
  }

  for (const update of result.notes_to_update) {
    try {
      store.update(update.id, update.changes);
      console.error(`hook: updated note ${update.id}`);
    } catch (err) {
      console.error(`hook: failed to update ${update.id}:`, err);
    }
  }

  for (const sid of result.notes_to_supersede) {
    try {
      store.updateStatus(sid, "superseded");
      console.error(`hook: superseded note ${sid}`);
    } catch (err) {
      console.error(`hook: failed to supersede ${sid}:`, err);
    }
  }

  // Update cursor
  writeCursor(store.getBaseDir(), session_id, total);
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
