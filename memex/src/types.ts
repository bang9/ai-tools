export interface Note {
  id: string;
  content: string;
  type: string; // decision, question, pattern, risk, observation, todo
  tags: string[];
  sources: Source[];
  relations: Relation[];
  status: string; // open, resolved, superseded
  embedding?: number[];
  created_at: string;
  updated_at: string;
}

export interface Source {
  project: string; // git remote name or dir name
  path: string; // relative to project root
}

export function sourceKey(s: Source): string {
  return s.project ? `${s.project}:${s.path}` : s.path;
}

export interface Relation {
  target_id: string;
  type: string; // relates_to, depends_on, contradicts, supersedes, elaborates, blocks
}

export interface Config {
  auth_token?: string;
  api_key?: string;
  embedding_enabled: boolean;
  model: string;
}

export function defaultConfig(): Config {
  return {
    embedding_enabled: true,
    model: "claude-haiku-4-5-20251001",
  };
}

export type TagIndex = Record<string, string[]>;
export type SourceIndex = Record<string, string[]>;

export interface GraphEdge {
  target_id: string;
  type: string;
}

export type GraphIndex = Record<string, GraphEdge[]>;
export type EmbeddingIndex = Record<string, number[]>;

export interface NoteWithRelations {
  note: Note;
  incoming?: Relation[];
}

export interface NoteSummary {
  id: string;
  preview: string;
  type: string;
  tags: string[];
  status: string;
}

export interface NoteCandidate {
  content: string;
  tags: string[];
  sources: Source[];
  type: string;
}

export const SIMILARITY_THRESHOLDS = {
  SUPERSEDE: 0.9,
  UPDATE: 0.7,
  RELATE: 0.4,
} as const;

export type RoutingDecision =
  | { action: "supersede"; existingId: string; similarity: number }
  | { action: "update"; existingId: string; similarity: number }
  | { action: "add_related"; existingId: string; similarity: number }
  | { action: "add_independent" };

export interface SearchParams {
  tag?: string;
  source?: string;
  query?: string;
  type?: string;
  status?: string;
}

export function nowRFC3339(): string {
  return new Date().toISOString();
}

export function parseSource(s: string): Source {
  const idx = s.indexOf(":");
  if (idx >= 0) {
    return { project: s.slice(0, idx), path: s.slice(idx + 1) };
  }
  return { project: "", path: s };
}
