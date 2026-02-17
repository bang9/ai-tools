import type { Turn } from "./collector.js";
import type { NoteSummary, Source } from "./types.js";

// --- Output types ---

export interface NoteToAdd {
  content: string;
  tags: string[];
  sources: Source[];
  status: string;
}

export interface NoteToUpdate {
  id: string;
  changes: {
    content?: string;
    status?: string;
    tags?: string[];
  };
}

export interface AnalysisResult {
  notes_to_add: NoteToAdd[];
  notes_to_update: NoteToUpdate[];
  notes_to_supersede: string[];
}

// JSON Schema for structured output
export const analysisSchema = {
  type: "object",
  properties: {
    notes_to_add: {
      type: "array",
      items: {
        type: "object",
        properties: {
          content: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          sources: {
            type: "array",
            items: {
              type: "object",
              properties: {
                project: { type: "string" },
                path: { type: "string" },
              },
              required: ["project", "path"],
            },
          },
          status: { type: "string" },
        },
        required: ["content", "tags", "sources", "status"],
      },
    },
    notes_to_update: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          changes: {
            type: "object",
            properties: {
              content: { type: "string" },
              status: { type: "string" },
              tags: { type: "array", items: { type: "string" } },
            },
          },
        },
        required: ["id", "changes"],
      },
    },
    notes_to_supersede: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["notes_to_add", "notes_to_update", "notes_to_supersede"],
};

// --- Prompt builder ---

export function buildAnalysisPrompt(
  newTurns: Turn[],
  sessionSummary: string,
  existingNotes: NoteSummary[],
  cwd: string,
): string {
  let prompt = `You are a knowledge extraction agent for a developer's local knowledge graph.
Analyze the conversation turns below and extract knowledge worth persisting across sessions.

## What to extract:
- Architectural decisions (technology choices, design patterns, tradeoffs)
- Recurring patterns (code conventions, naming rules, project idioms)
- File-specific knowledge (purpose of files, non-obvious behavior, gotchas)
- Risks identified (security concerns, performance bottlenecks, fragile code)
- Open questions (unresolved issues, things to investigate)
- Todos (deferred work, follow-up tasks, known tech debt)

## Rules:
- Only extract knowledge with lasting value (skip transient/trivial exchanges)
- Be specific — include the "why", not just the "what"
- Use tags for categorization (e.g., "architecture", "auth", "performance")
- Set sources to the relevant file paths discussed (project from cwd basename)
- Check existing notes to avoid duplicates — update or supersede instead
- If a new insight contradicts or replaces an existing note, add it to notes_to_supersede
- Status should be "open" for most new notes

## Working directory: ${cwd}

## Session context (for background):
${sessionSummary}

## New conversation turns to analyze:
`;

  for (const turn of newTurns) {
    prompt += `[${turn.role}] ${turn.text}\n\n`;
  }

  if (existingNotes.length > 0) {
    prompt += "\n## Existing notes (check for duplicates/supersession):\n";
    for (const note of existingNotes) {
      prompt += `- ID: ${note.id} | Type: ${note.type} | Tags: ${note.tags.join(", ")} | Status: ${note.status} | ${note.preview}\n`;
    }
  }

  prompt += `
## Instructions:
Return the extracted knowledge. If nothing worth persisting is found, return empty arrays.
`;

  return prompt;
}

// --- Analyzer ---

export async function analyzeSession(
  newTurns: Turn[],
  sessionSummary: string,
  existingNotes: NoteSummary[],
  cwd: string,
  authToken?: string,
  apiKey?: string,
  model?: string,
): Promise<AnalysisResult> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  const prompt = buildAnalysisPrompt(newTurns, sessionSummary, existingNotes, cwd);

  // Strip CLAUDECODE env to avoid nested session error
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.CLAUDECODE;

  // Auth priority: env > config.auth_token > config.api_key
  if (!env.CLAUDE_CODE_OAUTH_TOKEN && !env.ANTHROPIC_API_KEY) {
    if (authToken) {
      env.CLAUDE_CODE_OAUTH_TOKEN = authToken;
    } else if (apiKey) {
      env.ANTHROPIC_API_KEY = apiKey;
    }
  }

  if (!env.CLAUDE_CODE_OAUTH_TOKEN && !env.ANTHROPIC_API_KEY) {
    console.error("analyzer: no auth found. Set via: memex config set auth_token <token>");
    return emptyResult();
  }

  try {
    for await (const message of query({
      prompt,
      options: {
        allowedTools: [],
        maxTurns: 1,
        tools: [],
        model: model ?? "claude-haiku-4-5-20251001",
        effort: "low" as const,
        persistSession: false,
        env,
        outputFormat: {
          type: "json_schema",
          schema: analysisSchema,
        },
      },
    })) {
      const msg = message as any;
      if (msg.type === "result") {
        if (msg.subtype === "success" && msg.structured_output) {
          return validateResult(msg.structured_output);
        }
        if (msg.subtype === "error_max_structured_output_retries") {
          console.error("analyzer: structured output failed after retries");
          return emptyResult();
        }
      }
    }
  } catch (err) {
    console.error("analyzer: query failed:", err);
  }

  return emptyResult();
}

function emptyResult(): AnalysisResult {
  return { notes_to_add: [], notes_to_update: [], notes_to_supersede: [] };
}

function validateResult(output: unknown): AnalysisResult {
  const result = output as AnalysisResult;
  return {
    notes_to_add: Array.isArray(result.notes_to_add) ? result.notes_to_add : [],
    notes_to_update: Array.isArray(result.notes_to_update) ? result.notes_to_update : [],
    notes_to_supersede: Array.isArray(result.notes_to_supersede) ? result.notes_to_supersede : [],
  };
}
