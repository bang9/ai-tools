/**
 * Persistent UI state (tab sessions, file browser expansion, …) backed by
 * `~/.grove/ui-state.json` via the backend, matching the panel-layouts
 * persistence convention. The file is loaded once at startup into an in-memory
 * cache so reads stay synchronous; writes update the cache and flush the whole
 * file on a short debounce.
 */

import { loadUiState, saveUiState } from "./platform";

const FLUSH_DELAY_MS = 300;

let cache: Record<string, unknown> = {};
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** Load the persisted state file into the cache. Call once before the UI mounts. */
export async function initUiStateStorage(): Promise<void> {
  try {
    const raw = await loadUiState();
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      cache = parsed as Record<string, unknown>;
    }
  } catch {
    // Unreadable state file — start fresh; the next save rewrites it.
  }
}

export function loadJsonState<T>(key: string): T | null {
  return (cache[key] as T | undefined) ?? null;
}

export function saveJsonState(key: string, value: unknown): void {
  cache = { ...cache, [key]: value };
  scheduleFlush();
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const serialized = JSON.stringify(cache);
    void Promise.resolve()
      .then(() => saveUiState(serialized))
      .catch(() => {
        // Persistence is best-effort — state simply won't survive a restart.
      });
  }, FLUSH_DELAY_MS);
}

/** Test-only: replace the in-memory cache. */
export function primeUiStateCacheForTests(state: Record<string, unknown>): void {
  cache = state;
}

/** Test-only: read the in-memory cache. */
export function readUiStateCacheForTests(): Record<string, unknown> {
  return cache;
}
