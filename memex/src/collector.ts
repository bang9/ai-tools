import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

export interface Turn {
  role: "user" | "assistant";
  text: string;
  lineNumber: number;
}

/**
 * Read the cursor (last processed line number) for a session.
 * Returns 0 if no cursor exists.
 */
export function readCursor(baseDir: string, sessionId: string): number {
  const cursorPath = cursorFilePath(baseDir, sessionId);
  try {
    return parseInt(readFileSync(cursorPath, "utf-8").trim(), 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Write cursor after processing.
 */
export function writeCursor(baseDir: string, sessionId: string, line: number): void {
  const dir = join(baseDir, "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(cursorFilePath(baseDir, sessionId), String(line));
}

/**
 * Extract new turns from transcript JSONL starting after the cursor position.
 * Only extracts user/assistant messages from the main chain (not sidechains).
 */
export function extractNewTurns(transcriptPath: string, cursor: number): Turn[] {
  if (!existsSync(transcriptPath)) return [];

  const content = readFileSync(transcriptPath, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());
  const turns: Turn[] = [];

  for (let i = cursor; i < lines.length; i++) {
    let entry: any;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }

    // Skip sidechains
    if (entry.isSidechain) continue;

    const type = entry.type;
    const msg = entry.message;
    if (!msg) continue;

    if (type === "user" && msg.role === "user") {
      const text = extractUserText(msg.content);
      if (text) turns.push({ role: "user", text, lineNumber: i + 1 });
    } else if (type === "assistant" && msg.role === "assistant") {
      const text = extractAssistantText(msg.content);
      if (text) turns.push({ role: "assistant", text, lineNumber: i + 1 });
    }
  }

  return turns;
}

/**
 * Get total line count of the transcript (for cursor update).
 */
export function totalLines(transcriptPath: string): number {
  if (!existsSync(transcriptPath)) return 0;
  const content = readFileSync(transcriptPath, "utf-8");
  return content.split("\n").filter((l) => l.trim()).length;
}

/**
 * Build a session summary from all turns (including already-processed ones)
 * for context. Limited to the last N turns.
 */
export function buildSessionSummary(transcriptPath: string, maxTurns = 50): string {
  const turns = extractNewTurns(transcriptPath, 0);
  const recent = turns.slice(-maxTurns);
  return recent.map((t) => `[${t.role}] ${truncate(t.text, 200)}`).join("\n");
}

// --- Internal ---

function cursorFilePath(baseDir: string, sessionId: string): string {
  return join(baseDir, "sessions", `${sessionId}.cursor`);
}

function extractUserText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n")
      .trim();
  }
  return "";
}

function extractAssistantText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  // Only extract text blocks, skip thinking and tool_use
  const texts = content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text);
  return texts.join("\n").trim();
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "...";
}
