import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import type { Note, NoteWithRelations, SearchParams, Relation } from "./types.js";
import { Store } from "./store.js";

export function search(store: Store, params: SearchParams): Note[] {
  const tags = store.tagsIndex();
  const sources = store.sourcesIndex();

  // Collect candidate sets from index lookups
  const candidateSets: Set<string>[] = [];

  if (params.tag) {
    candidateSets.push(new Set(tags[params.tag] ?? []));
  }

  if (params.source) {
    const set = new Set<string>();
    for (const [key, ids] of Object.entries(sources)) {
      if (key.startsWith(params.source)) {
        for (const id of ids) set.add(id);
      }
    }
    candidateSets.push(set);
  }

  // Intersect sets
  let candidateIDs: Set<string> | null = null;
  if (candidateSets.length > 0) {
    candidateIDs = candidateSets[0];
    for (let i = 1; i < candidateSets.length; i++) {
      const intersected = new Set<string>();
      for (const id of candidateIDs) {
        if (candidateSets[i].has(id)) intersected.add(id);
      }
      candidateIDs = intersected;
    }
  }

  // Load candidates
  let candidates: Note[];
  if (candidateIDs) {
    candidates = [];
    for (const id of candidateIDs) {
      try { candidates.push(store.get(id)); } catch { /* skip */ }
    }
  } else {
    candidates = store.list().map((s) => {
      try { return store.get(s.id); } catch { return null; }
    }).filter((n): n is Note => n !== null);
  }

  // Post-filter by type
  if (params.type) {
    candidates = candidates.filter((n) => n.type === params.type);
  }

  // Post-filter by status
  if (params.status) {
    candidates = candidates.filter((n) => n.status === params.status);
  }

  // Rank by query
  if (params.query) {
    candidates = bm25Rank(candidates, params.query);
  }

  return candidates;
}

export function context(store: Store, source: string, maxHops = 3): NoteWithRelations[] {
  const sources = store.sourcesIndex();
  const graph = store.graphIndex();

  // Find seed note IDs matching source prefix
  const seeds = new Set<string>();
  for (const [key, ids] of Object.entries(sources)) {
    if (key.startsWith(source)) {
      for (const id of ids) seeds.add(id);
    }
  }

  if (seeds.size === 0) return [];

  // BFS traversal
  const visited = new Set<string>();
  const queue: string[] = [];
  const depth = new Map<string, number>();

  for (const id of seeds) {
    queue.push(id);
    depth.set(id, 0);
    visited.add(id);
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentDepth = depth.get(current)!;
    if (currentDepth >= maxHops) continue;

    // Follow outgoing edges
    for (const edge of graph[current] ?? []) {
      if (!visited.has(edge.target_id)) {
        visited.add(edge.target_id);
        depth.set(edge.target_id, currentDepth + 1);
        queue.push(edge.target_id);
      }
    }

    // Follow incoming edges
    for (const [nid, edges] of Object.entries(graph)) {
      for (const edge of edges) {
        if (edge.target_id === current && !visited.has(nid)) {
          visited.add(nid);
          depth.set(nid, currentDepth + 1);
          queue.push(nid);
        }
      }
    }
  }

  // Load notes with relation metadata
  const results: NoteWithRelations[] = [];
  for (const id of visited) {
    try {
      const note = store.get(id);
      const incoming: Relation[] = [];

      for (const [nid, edges] of Object.entries(graph)) {
        if (nid === id) continue;
        for (const edge of edges) {
          if (edge.target_id === id) {
            incoming.push({ target_id: nid, type: edge.type });
          }
        }
      }

      results.push({ note, incoming: incoming.length > 0 ? incoming : undefined });
    } catch { /* skip */ }
  }

  return results;
}

// --- BM25+ Ranking ---

function bm25Rank(notes: Note[], query: string): Note[] {
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return notes;

  // Document frequencies
  const df = new Map<string, number>();
  for (const note of notes) {
    const terms = new Set(tokenize(note.content));
    for (const t of terms) df.set(t, (df.get(t) ?? 0) + 1);
  }

  // Average document length
  let totalLen = 0;
  for (const note of notes) totalLen += tokenize(note.content).length;
  const avgDL = totalLen / Math.max(notes.length, 1);

  const N = notes.length;
  const k1 = 1.2;
  const b = 0.75;

  const scored: { note: Note; score: number }[] = [];

  for (const note of notes) {
    const docTerms = tokenize(note.content);
    const tf = new Map<string, number>();
    for (const t of docTerms) tf.set(t, (tf.get(t) ?? 0) + 1);

    const dl = docTerms.length;
    let score = 0;

    for (const qt of queryTerms) {
      const termTf = tf.get(qt) ?? 0;
      if (termTf === 0) continue;
      const termDf = df.get(qt) ?? 0;
      const idf = Math.log(1 + (N - termDf + 0.5) / (termDf + 0.5));
      const tfNorm = (termTf * (k1 + 1)) / (termTf + k1 * (1 - b + b * dl / avgDL));
      score += idf * tfNorm;
    }

    if (score > 0) scored.push({ note, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.note);
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function keywordOverlapScore(a: string, b: string): number {
  const tokensA = new Set(tokenize(a));
  const tokensB = new Set(tokenize(b));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let overlap = 0;
  for (const t of tokensA) if (tokensB.has(t)) overlap++;
  const union = tokensA.size + tokensB.size - overlap;
  return union === 0 ? 0 : overlap / union;
}
