import { Store } from "./store.js";
import { cosineSimilarity } from "./search.js";

// Lazy-loaded sentence-transformer pipeline
let extractor: any = null;
let extractorFailed = false;

async function getExtractor(): Promise<any> {
  if (extractor) return extractor;
  if (extractorFailed) return null;

  try {
    const { pipeline } = await import("@huggingface/transformers");
    extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
    return extractor;
  } catch (err) {
    extractorFailed = true;
    console.error("embedder: failed to load model, falling back to BoW:", err);
    return null;
  }
}

async function computeEmbedding(text: string): Promise<number[]> {
  const ext = await getExtractor();
  if (ext) {
    const output = await ext(text, { pooling: "mean", normalize: true });
    return Array.from(output.data as Float32Array);
  }
  // Fallback to BoW if model unavailable
  return bowEmbedding(text);
}

export class Embedder {
  private queue: string[] = [];
  private processing = false;
  private store: Store;
  private enabled: boolean;

  constructor(store: Store, enabled: boolean) {
    this.store = store;
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  enqueue(id: string): void {
    if (!this.enabled) return;
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
        console.error(`embedder: failed to process note ${id}:`, err);
      }
    }

    this.processing = false;
  }

  private async processNote(id: string): void {
    const note = this.store.get(id);
    const embedding = await computeEmbedding(note.content);
    this.store.setEmbedding(id, embedding);
  }

  async similarNotes(query: string, k: number): Promise<string[]> {
    if (!this.enabled) return [];
    const queryEmb = await computeEmbedding(query);
    const allEmbs = this.store.allEmbeddings();

    const scored: { id: string; score: number }[] = [];
    for (const [id, emb] of Object.entries(allEmbs)) {
      const sim = cosineSimilarity(queryEmb, emb);
      if (sim > 0.1) scored.push({ id, score: sim });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k).map((s) => s.id);
  }
}

// --- BoW fallback ---

function bowEmbedding(text: string): number[] {
  const tokens = text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  const vec = new Float32Array(384);

  for (const token of tokens) {
    const h = fnv1a(token);
    for (let i = 0; i < 3; i++) {
      const idx = ((h + i * 2654435761) >>> 0) % 384;
      vec[idx] += (h & (1 << i)) ? 1 : -1;
    }
  }

  let norm = 0;
  for (const v of vec) norm += v * v;
  if (norm > 0) {
    norm = Math.sqrt(norm);
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  }

  return Array.from(vec);
}

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
