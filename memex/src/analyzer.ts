import type { Turn } from "./collector.js";
import type { NoteCandidate, Source } from "./types.js";

// --- Output types ---

export interface AnalysisResult {
  notes: NoteCandidate[];
}

// JSON Schema for structured output
export const analysisSchema = {
  type: "object",
  properties: {
    notes: {
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
          type: { type: "string" },
        },
        required: ["content", "tags", "sources", "type"],
      },
    },
  },
  required: ["notes"],
};

// --- Prompt builder ---

export function buildAnalysisPrompt(
  newTurns: Turn[],
  sessionSummary: string,
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
- Status is not your concern — just extract the knowledge content
- Do NOT worry about deduplication — that is handled downstream by embeddings

## Working directory: ${cwd}

## Session context (for background):
${sessionSummary}

## New conversation turns to analyze:
`;

  for (const turn of newTurns) {
    prompt += `[${turn.role}] ${turn.text}\n\n`;
  }

  prompt += `
## Instructions:
Return the extracted knowledge. If nothing worth persisting is found, return an empty notes array.
`;

  return prompt;
}

// --- Analyzer ---

export async function analyzeSession(
  newTurns: Turn[],
  sessionSummary: string,
  cwd: string,
  authToken?: string,
  apiKey?: string,
  model?: string,
): Promise<AnalysisResult> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  const prompt = buildAnalysisPrompt(newTurns, sessionSummary, cwd);

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
  return { notes: [] };
}

function validateResult(output: unknown): AnalysisResult {
  const result = output as AnalysisResult;
  return {
    notes: Array.isArray(result.notes) ? result.notes : [],
  };
}
