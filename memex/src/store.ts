import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, existsSync, renameSync, chmodSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import { homedir } from "os";
import type {
  Note, Source, Relation, Config, TagIndex, SourceIndex,
  GraphIndex, GraphEdge, EmbeddingIndex, NoteSummary, NoteWithRelations,
} from "./types.js";
import { sourceKey, nowRFC3339, defaultConfig } from "./types.js";

export class Store {
  private baseDir: string;
  private tags: TagIndex = {};
  private sources: SourceIndex = {};
  private graph: GraphIndex = {};
  private embeddings: EmbeddingIndex = {};

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(homedir(), ".memex");
    for (const sub of ["notes", "index", "embeddings"]) {
      mkdirSync(join(this.baseDir, sub), { recursive: true });
    }
    this.loadIndexes();
  }

  // --- CRUD ---

  add(note: Partial<Note> & { content: string }): string {
    const id = note.id ?? generateID();
    const now = nowRFC3339();

    const full: Note = {
      id,
      content: note.content,
      type: note.type ?? "",
      tags: note.tags ?? [],
      sources: note.sources ?? [],
      relations: note.relations ?? [],
      status: note.status ?? "open",
      created_at: now,
      updated_at: now,
    };

    this.writeNote(full);
    this.indexAdd(full);
    this.flushIndexes();
    return id;
  }

  get(id: string): Note {
    return this.readNote(id);
  }

  update(id: string, updates: Partial<Pick<Note, "content" | "type" | "status" | "tags" | "sources">>): void {
    const note = this.readNote(id);
    this.indexRemove(note);

    if (updates.content !== undefined) note.content = updates.content;
    if (updates.type !== undefined) note.type = updates.type;
    if (updates.status !== undefined) note.status = updates.status;
    if (updates.tags !== undefined) note.tags = updates.tags;
    if (updates.sources !== undefined) note.sources = updates.sources;
    note.updated_at = nowRFC3339();

    this.writeNote(note);
    this.indexAdd(note);
    this.flushIndexes();
  }

  delete(id: string): void {
    const note = this.readNote(id);
    unlinkSync(this.notePath(id));
    this.indexRemove(note);

    // Clean graph edges (outgoing + incoming)
    delete this.graph[id];
    for (const [nid, edges] of Object.entries(this.graph)) {
      const filtered = edges.filter((e) => e.target_id !== id);
      if (filtered.length === 0) delete this.graph[nid];
      else this.graph[nid] = filtered;
    }

    delete this.embeddings[id];
    this.flushIndexes();
    this.flushEmbeddings();
  }

  list(): NoteSummary[] {
    const dir = join(this.baseDir, "notes");
    if (!existsSync(dir)) return [];

    const entries = readdirSync(dir).filter((f) => f.endsWith(".json"));
    return entries.map((f) => {
      const id = f.replace(".json", "");
      try {
        const note = this.readNote(id);
        let preview = note.content;
        const nl = preview.indexOf("\n");
        if (nl >= 0) preview = preview.slice(0, nl);
        if (preview.length > 80) preview = preview.slice(0, 80) + "...";
        return { id: note.id, preview, type: note.type, tags: note.tags, status: note.status };
      } catch {
        return null;
      }
    }).filter((x): x is NoteSummary => x !== null);
  }

  // --- Relations ---

  addRelations(id: string, relations: Relation[]): void {
    const note = this.readNote(id);
    note.relations.push(...relations);
    note.updated_at = nowRFC3339();
    this.writeNote(note);

    for (const rel of relations) {
      if (!this.graph[id]) this.graph[id] = [];
      this.graph[id].push({ target_id: rel.target_id, type: rel.type });
    }
    this.flushIndexes();
  }

  updateStatus(id: string, status: string): void {
    this.update(id, { status });
  }

  // --- Embeddings ---

  setEmbedding(id: string, embedding: number[]): void {
    this.embeddings[id] = embedding;
    this.flushEmbeddings();
  }

  getEmbedding(id: string): number[] | undefined {
    return this.embeddings[id];
  }

  allEmbeddings(): Record<string, number[]> {
    return { ...this.embeddings };
  }

  // --- Config ---

  getConfig(): Config {
    const cfg = defaultConfig();
    try {
      const data = readFileSync(join(this.baseDir, "config.json"), "utf-8");
      const parsed = JSON.parse(data);
      Object.assign(cfg, parsed);
      if (!cfg.model) cfg.model = defaultConfig().model;
    } catch {
      // No config file yet
    }
    return cfg;
  }

  setConfig(key: string, value: string): void {
    const cfg = this.getConfig();
    switch (key) {
      case "auth_token": cfg.auth_token = value; break;
      case "api_key": cfg.api_key = value; break;
      case "embedding_enabled": cfg.embedding_enabled = value === "true"; break;
      case "model": cfg.model = value; break;
      default: throw new Error(`Unknown config key: ${key}`);
    }
    atomicWrite(join(this.baseDir, "config.json"), JSON.stringify(cfg, null, 2), 0o600);
  }

  // --- Index accessors (copies for read-only use) ---

  getBaseDir(): string { return this.baseDir; }
  tagsIndex(): TagIndex { return JSON.parse(JSON.stringify(this.tags)); }
  sourcesIndex(): SourceIndex { return JSON.parse(JSON.stringify(this.sources)); }
  graphIndex(): GraphIndex { return JSON.parse(JSON.stringify(this.graph)); }

  // --- Internal ---

  private notePath(id: string): string {
    if (!/^[a-f0-9]+$/.test(id)) {
      throw new Error(`invalid note ID: ${id}`);
    }
    return join(this.baseDir, "notes", `${id}.json`);
  }

  private readNote(id: string): Note {
    const p = this.notePath(id);
    if (!existsSync(p)) throw new Error(`note not found: ${id}`);
    return JSON.parse(readFileSync(p, "utf-8"));
  }

  private writeNote(note: Note): void {
    atomicWrite(this.notePath(note.id), JSON.stringify(note, null, 2));
  }

  private indexAdd(note: Note): void {
    for (const tag of note.tags) {
      if (!this.tags[tag]) this.tags[tag] = [];
      if (!this.tags[tag].includes(note.id)) this.tags[tag].push(note.id);
    }
    for (const src of note.sources) {
      const key = sourceKey(src);
      if (!this.sources[key]) this.sources[key] = [];
      if (!this.sources[key].includes(note.id)) this.sources[key].push(note.id);
    }
    for (const rel of note.relations) {
      if (!this.graph[note.id]) this.graph[note.id] = [];
      this.graph[note.id].push({ target_id: rel.target_id, type: rel.type });
    }
  }

  private indexRemove(note: Note): void {
    for (const tag of note.tags) {
      if (this.tags[tag]) {
        this.tags[tag] = this.tags[tag].filter((id) => id !== note.id);
        if (this.tags[tag].length === 0) delete this.tags[tag];
      }
    }
    for (const src of note.sources) {
      const key = sourceKey(src);
      if (this.sources[key]) {
        this.sources[key] = this.sources[key].filter((id) => id !== note.id);
        if (this.sources[key].length === 0) delete this.sources[key];
      }
    }
    delete this.graph[note.id];
  }

  private flushIndexes(): void {
    this.saveIndex("tags.json", this.tags);
    this.saveIndex("sources.json", this.sources);
    this.saveIndex("graph.json", this.graph);
  }

  private loadIndexes(): void {
    this.tags = this.loadIndex("tags.json") ?? {};
    this.sources = this.loadIndex("sources.json") ?? {};
    this.graph = this.loadIndex("graph.json") ?? {};
    this.loadEmbeddings();
  }

  private loadIndex<T>(filename: string): T | null {
    try {
      return JSON.parse(readFileSync(join(this.baseDir, "index", filename), "utf-8"));
    } catch {
      return null;
    }
  }

  private saveIndex(filename: string, data: unknown): void {
    atomicWrite(join(this.baseDir, "index", filename), JSON.stringify(data, null, 2));
  }

  private loadEmbeddings(): void {
    try {
      this.embeddings = JSON.parse(readFileSync(join(this.baseDir, "embeddings", "vectors.json"), "utf-8"));
    } catch {
      this.embeddings = {};
    }
  }

  private flushEmbeddings(): void {
    atomicWrite(join(this.baseDir, "embeddings", "vectors.json"), JSON.stringify(this.embeddings, null, 2));
  }
}

function generateID(): string {
  return randomBytes(4).toString("hex");
}

function atomicWrite(path: string, data: string, mode?: number): void {
  const tmp = path + "." + randomBytes(4).toString("hex") + ".tmp";
  writeFileSync(tmp, data, mode != null ? { mode } : undefined);
  renameSync(tmp, path);
}
