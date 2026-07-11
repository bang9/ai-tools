/**
 * Coalesces dense keystroke/paste input bursts into fewer backend writes.
 *
 * `term.onData` fires once per input event. Under trackpad-momentum SGR mouse
 * reports or key auto-repeat that is a flood of tiny async `writePty` calls,
 * each paying its own IPC round-trip and a global-registry-locked backend
 * write. This queue accumulates whole encoded chunks produced within a single
 * synchronous burst and flushes them as one write on a microtask boundary.
 *
 * Correctness rules (see also the perf spec):
 *  - The emitted byte stream is byte-IDENTICAL to the un-coalesced stream, just
 *    re-chunked: only whole chunks are ever concatenated, never split, so UTF-8
 *    and escape-sequence integrity is preserved automatically (each onData
 *    string is fully encoded before it is appended).
 *  - {@link COALESCE_MAX} is enforced with a chunk-BOUNDARY flush: the pending
 *    buffer is flushed BEFORE appending a chunk that would exceed the cap.
 *  - Flushing happens on a microtask (`queueMicrotask`) — never a nested
 *    `setTimeout`, which Chromium clamps to 4ms after ~5 levels. xterm.js routes
 *    CPR/DA/DSR query replies through the same onData path; a microtask flush
 *    keeps accumulation within one synchronous turn and adds ~0 latency, so
 *    synthetic query replies are never delayed past the current event-loop turn.
 */

/** Cap coalesced input safely under any backend write chunk limit. */
export const COALESCE_MAX = 4096;

export interface PtyInputQueueOptions {
  /**
   * Emits one coalesced byte batch. Called in enqueue order; keep it
   * fire-and-forget in order (do not reorder) to preserve per-PTY ordering.
   */
  flush: (data: Uint8Array) => void;
  /**
   * Schedules `drain` on a microtask boundary. Defaults to `queueMicrotask`.
   * Injectable for tests.
   */
  schedule?: (drain: () => void) => void;
  /** Overrides {@link COALESCE_MAX}; used by tests. */
  maxBytes?: number;
}

function concat(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  if (chunks.length === 1) {
    return chunks[0];
  }
  const out = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export class PtyInputQueue {
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private scheduled = false;
  private readonly flush: (data: Uint8Array) => void;
  private readonly schedule: (drain: () => void) => void;
  private readonly maxBytes: number;

  constructor(options: PtyInputQueueOptions) {
    this.flush = options.flush;
    this.schedule = options.schedule ?? ((drain) => queueMicrotask(drain));
    this.maxBytes = options.maxBytes ?? COALESCE_MAX;
  }

  enqueue(chunk: Uint8Array) {
    if (chunk.length === 0) {
      return;
    }

    // Chunk-boundary cap: flush what we have BEFORE appending a chunk that
    // would overflow the cap, so no chunk is ever split.
    if (this.pendingBytes > 0 && this.pendingBytes + chunk.length > this.maxBytes) {
      this.drain();
    }

    this.pending.push(chunk);
    this.pendingBytes += chunk.length;

    // A single chunk at/over the cap flushes immediately (still whole) to avoid
    // unbounded buffering of a very large paste.
    if (this.pendingBytes >= this.maxBytes) {
      this.drain();
      return;
    }

    if (!this.scheduled) {
      this.scheduled = true;
      this.schedule(() => this.drain());
    }
  }

  /**
   * Concatenates the pending whole chunks and emits them as one batch, in
   * order. Idempotent when empty, so a redundant scheduled drain after a
   * synchronous cap-flush is harmless.
   */
  drain() {
    this.scheduled = false;
    if (this.pendingBytes === 0) {
      this.pending = [];
      return;
    }

    const batch = concat(this.pending, this.pendingBytes);
    this.pending = [];
    this.pendingBytes = 0;
    this.flush(batch);
  }
}
