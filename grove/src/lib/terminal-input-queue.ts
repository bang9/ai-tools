/**
 * Serializes terminal input writes with paste chunking + acceptance-gated pacing.
 *
 * `term.onData` fires once per input event. Three problems this queue solves:
 *  1. A multi-MB paste arrives as ONE onData payload; writing it as a single
 *     unbounded batch stalls the backend and balloons memory.
 *  2. Fire-and-forget writes let the JS layer outrun the PTY, so a slow backend
 *     accumulates unbounded in-flight bytes.
 *  3. A mid-paste query reply (CPR/DA/DSR) synthesized by xterm must not stall
 *     behind hundreds of unsent paste chunks — the program is blocking on it.
 *
 * Design:
 *  - Interactive input keeps today's microtask coalescing cadence (small volume;
 *    per-PTY FIFO in the backend orders everything). It is accumulated within one
 *    synchronous turn and flushed as one segment on a microtask boundary.
 *  - A paste (onData payload above {@link PASTE_DIRECT_MAX_BYTES}) is split into
 *    ~{@link PASTE_CHUNK_BYTES} pieces at UTF-8 code-point boundaries, never
 *    bisecting the bracketed-paste markers ESC[200~ / ESC[201~, and truncated at
 *    a UTF-8 boundary if it exceeds {@link PASTE_CEILING_BYTES} (silent — no UI).
 *  - Every segment drains through ONE serial loop: chunk N+1's write is issued
 *    only after chunk N's write resolves (Unit R resolves after bytes physically
 *    land). This paces the stream and bounds queued bytes without dropping.
 *  - Interactive input enqueued while a paste chain is draining goes BEHIND the
 *    remaining chunks (JS-layer per-PTY FIFO), so a user's Enter after a paste
 *    never jumps ahead of unsent paste chunks.
 *  - A query reply may be inserted ahead of the remaining UNSENT paste chunks
 *    (never preempting the in-flight write, never reordering vs interactive input
 *    already ahead of the paste).
 *
 * isComposing() is intentionally NOT consulted here — IME/paste sanitization is
 * the Phase-5 paste-sanitizer's job. All logic stays at the enqueue boundary.
 */

/** Cap coalesced interactive input safely under any backend write chunk limit. */
export const COALESCE_MAX = 4096;

/** onData payloads at/under this size are treated as interactive, never chunked. */
export const PASTE_DIRECT_MAX_BYTES = 64 * 1024;

/** Target size for each split paste chunk. */
export const PASTE_CHUNK_BYTES = 16 * 1024;

/** Generous hard ceiling; a paste above this is silently truncated at a UTF-8 boundary. */
export const PASTE_CEILING_BYTES = 8 * 1024 * 1024;

/**
 * Exact-match shapes for xterm-synthesized query replies, matched on the ASCII
 * body AFTER the raw `ESC[` prefix (checked as bytes so no control char appears
 * in the regex). The ONLY payloads eligible for the priority lane:
 *  - CPR:      ESC[<r>;<c>R
 *  - DECXCPR:  ESC[?<r>;<c>;<p>R
 *  - Primary DA:   ESC[?...c
 *  - Secondary DA: ESC[>...c
 *  - DSR-ok:   ESC[0n
 * Anchored so arrow keys (ESC[A) and user ESC sequences never match.
 */
const QUERY_REPLY_BODY_RE = /^(?:\d+;\d+R|\?\d+;\d+;\d+R|\?[\d;]*c|>[\d;]*c|0n)$/;

/**
 * True iff `bytes` is EXACTLY a known query-reply shape and <64 bytes. Pure.
 * Rejects arrow keys, user ESC sequences, and any payload with a non-ASCII byte.
 */
export function isQueryReply(bytes: Uint8Array): boolean {
  const len = bytes.length;
  // Why: every reply is `ESC[` + tiny ASCII body; a >=64B, non-`ESC[`-prefixed,
  // or non-ASCII payload cannot be one, and the guards keep the spread cheap.
  if (len < 4 || len >= 64 || bytes[0] !== 0x1b || bytes[1] !== 0x5b) {
    return false;
  }
  for (let i = 2; i < len; i++) {
    if (bytes[i] >= 0x80) {
      return false;
    }
  }
  return QUERY_REPLY_BODY_RE.test(String.fromCharCode(...bytes.subarray(2)));
}

// Bracketed-paste markers: ESC [ 2 0 0 ~  and  ESC [ 2 0 1 ~ (6 bytes each).
function isMarkerStartAt(b: Uint8Array, i: number): boolean {
  if (b[i] !== 0x1b || b[i + 1] !== 0x5b || b[i + 2] !== 0x32 || b[i + 3] !== 0x30) {
    return false;
  }
  const fifth = b[i + 4];
  if (fifth !== 0x30 && fifth !== 0x31) {
    return false;
  }
  return b[i + 5] === 0x7e;
}

// UTF-8 byte length of the code point led by `lead`; a continuation/invalid
// byte advances by 1 so scanning always makes progress on valid input.
function utf8CodePointLength(lead: number): number {
  if (lead < 0x80) return 1;
  if ((lead & 0xe0) === 0xc0) return 2;
  if ((lead & 0xf0) === 0xe0) return 3;
  if ((lead & 0xf8) === 0xf0) return 4;
  return 1;
}

// Largest index <= limit that starts a UTF-8 code point (backs off continuation bytes).
function utf8BoundaryAtOrBefore(bytes: Uint8Array, limit: number): number {
  let cut = Math.min(limit, bytes.length);
  while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) {
    cut--;
  }
  return cut;
}

// If a bracketed-paste marker straddles `cut`, back the cut up to the marker start
// so a ceiling truncation never bisects ESC[200~ / ESC[201~.
function markerSafeCut(bytes: Uint8Array, cut: number): number {
  for (let d = 1; d <= 5; d++) {
    const s = cut - d;
    if (s >= 0 && isMarkerStartAt(bytes, s)) {
      // Marker spans [s, s+6); s+6 = cut + (6-d) > cut, so cut is inside it.
      return s;
    }
  }
  return cut;
}

export interface SplitPasteOptions {
  chunkBytes?: number;
  ceilingBytes?: number;
}

/**
 * Splits a paste payload into <=chunkBytes pieces at UTF-8 code-point boundaries,
 * never bisecting a bracketed-paste marker (a marker rides with its adjacent
 * content chunk or alone). Applies the byte ceiling first, truncating at a UTF-8
 * boundary. Concatenating the result === the post-ceiling input, plus a
 * synthetic ESC[201~ when the truncation stranded an unmatched opener. Pure.
 */
export function splitPasteInput(input: Uint8Array, options: SplitPasteOptions = {}): Uint8Array[] {
  const chunkBytes = options.chunkBytes ?? PASTE_CHUNK_BYTES;
  const ceilingBytes = options.ceilingBytes ?? PASTE_CEILING_BYTES;

  let end = input.length;
  if (end > ceilingBytes) {
    end = markerSafeCut(input, utf8BoundaryAtOrBefore(input, ceilingBytes));
  }
  const data = input.subarray(0, end);
  const chunks: Uint8Array[] = [];
  if (data.length === 0) {
    return chunks;
  }

  // Why: a ceiling cut usually lands deep inside the pasted content, stranding
  // the leading ESC[200~ without its closer — the shell would then stay in
  // bracketed-paste mode and swallow all further input. Close it synthetically.
  const needsSyntheticCloser = end < input.length && hasUnmatchedPasteOpener(data);

  const markerStarts = new Set<number>();
  for (let i = 0; i + 6 <= data.length; i++) {
    if (isMarkerStartAt(data, i)) {
      markerStarts.add(i);
    }
  }

  // Adjust a break at `i` so it never lands strictly inside a marker: break
  // before the marker (it leads the next chunk), or — if the marker sits at the
  // chunk start — after it (it rides alone in this chunk).
  const adjustBreak = (i: number, chunkStart: number): number => {
    for (let d = 1; d <= 5; d++) {
      const s = i - d;
      if (s >= chunkStart && markerStarts.has(s)) {
        return s === chunkStart ? s + 6 : s;
      }
    }
    return i;
  };

  let chunkStart = 0;
  let i = 0;
  let curBytes = 0;
  while (i < data.length) {
    const len = utf8CodePointLength(data[i]);
    if (curBytes > 0 && curBytes + len > chunkBytes) {
      const br = adjustBreak(i, chunkStart);
      chunks.push(data.subarray(chunkStart, br));
      chunkStart = br;
      if (br > i) {
        // Marker at chunk start pushed the break past `i`; skip to it.
        i = br;
        curBytes = 0;
        continue;
      }
      curBytes = i - br;
    }
    curBytes += len;
    i += len;
  }
  if (chunkStart < data.length) {
    chunks.push(data.subarray(chunkStart));
  }
  if (needsSyntheticCloser) {
    chunks.push(PASTE_CLOSE_MARKER.slice());
  }
  return chunks;
}

// ESC [ 2 0 1 ~ — bracketed-paste close marker.
const PASTE_CLOSE_MARKER = new Uint8Array([0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e]);

// True when `data` retains more ESC[200~ openers than ESC[201~ closers.
function hasUnmatchedPasteOpener(data: Uint8Array): boolean {
  let balance = 0;
  for (let i = 0; i + 6 <= data.length; i++) {
    if (isMarkerStartAt(data, i)) {
      balance += data[i + 4] === 0x30 ? 1 : -1;
      i += 5;
    }
  }
  return balance > 0;
}

export interface PtyInputQueueOptions {
  /**
   * Writes one segment to the backend. MUST resolve only after the bytes land
   * (Unit R contract) so pacing gates chunk N+1 on chunk N's acceptance.
   */
  write: (data: Uint8Array) => void | Promise<void>;
  /** Schedules the interactive coalesce flush. Defaults to `queueMicrotask`. */
  schedule?: (drain: () => void) => void;
  /** Reports a write rejection (e.g. a frozen backend after ~30s). */
  onWriteError?: (error: unknown) => void;
  /** Overrides {@link COALESCE_MAX}; used by tests. */
  maxBytes?: number;
  /** Overrides {@link PASTE_DIRECT_MAX_BYTES}; used by tests. */
  directThreshold?: number;
  /** Overrides {@link PASTE_CHUNK_BYTES}; used by tests. */
  chunkBytes?: number;
  /** Overrides {@link PASTE_CEILING_BYTES}; used by tests. */
  ceilingBytes?: number;
}

type SegmentKind = "interactive" | "paste" | "reply";

interface Segment {
  kind: SegmentKind;
  data: Uint8Array;
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
  private readonly fifo: Segment[] = [];
  private pendingInteractive: Uint8Array[] = [];
  private pendingInteractiveBytes = 0;
  private interactiveScheduled = false;
  private draining = false;

  private readonly write: (data: Uint8Array) => void | Promise<void>;
  private readonly schedule: (drain: () => void) => void;
  private readonly onWriteError?: (error: unknown) => void;
  private readonly maxBytes: number;
  private readonly directThreshold: number;
  private readonly chunkBytes: number;
  private readonly ceilingBytes: number;

  constructor(options: PtyInputQueueOptions) {
    this.write = options.write;
    this.schedule = options.schedule ?? ((drain) => queueMicrotask(drain));
    this.onWriteError = options.onWriteError;
    this.maxBytes = options.maxBytes ?? COALESCE_MAX;
    this.directThreshold = options.directThreshold ?? PASTE_DIRECT_MAX_BYTES;
    this.chunkBytes = options.chunkBytes ?? PASTE_CHUNK_BYTES;
    this.ceilingBytes = options.ceilingBytes ?? PASTE_CEILING_BYTES;
  }

  /** Bytes buffered but not yet handed to `write` (excludes the in-flight write). */
  get queuedBytes(): number {
    let total = this.pendingInteractiveBytes;
    for (const segment of this.fifo) {
      total += segment.data.length;
    }
    return total;
  }

  enqueue(chunk: Uint8Array) {
    if (chunk.length === 0) {
      return;
    }

    // Query-reply priority lane: a reply is exact-matched and always <64 bytes,
    // so this can never divert a genuine paste (>=64 bytes). Checked before the
    // paste threshold so recognition is independent of the paste-size tuning.
    if (isQueryReply(chunk) && this.hasPendingPasteChunk()) {
      this.insertReplyAheadOfPaste(chunk);
      this.ensureDraining();
      return;
    }

    if (chunk.length > this.directThreshold) {
      // Paste: flush anything typed before it (stays ahead of the chunks), then
      // split and queue the chunks behind it.
      this.flushPendingInteractive();
      for (const piece of splitPasteInput(chunk, {
        chunkBytes: this.chunkBytes,
        ceilingBytes: this.ceilingBytes,
      })) {
        this.fifo.push({ kind: "paste", data: piece });
      }
      this.ensureDraining();
      return;
    }

    this.appendInteractive(chunk);
  }

  private appendInteractive(chunk: Uint8Array) {
    // Chunk-boundary cap: flush before appending a chunk that would overflow the
    // cap so a coalesced batch never grows unbounded.
    if (
      this.pendingInteractiveBytes > 0 &&
      this.pendingInteractiveBytes + chunk.length > this.maxBytes
    ) {
      this.flushPendingInteractive();
      this.ensureDraining();
    }

    this.pendingInteractive.push(chunk);
    this.pendingInteractiveBytes += chunk.length;

    // A single chunk at/over the cap flushes immediately (still whole).
    if (this.pendingInteractiveBytes >= this.maxBytes) {
      this.flushPendingInteractive();
      this.ensureDraining();
      return;
    }

    if (!this.interactiveScheduled) {
      this.interactiveScheduled = true;
      this.schedule(() => {
        this.interactiveScheduled = false;
        this.flushPendingInteractive();
        this.ensureDraining();
      });
    }
  }

  private flushPendingInteractive() {
    if (this.pendingInteractiveBytes === 0) {
      this.pendingInteractive = [];
      return;
    }
    const data = concat(this.pendingInteractive, this.pendingInteractiveBytes);
    this.pendingInteractive = [];
    this.pendingInteractiveBytes = 0;
    this.fifo.push({ kind: "interactive", data });
  }

  private hasPendingPasteChunk(): boolean {
    return this.fifo.some((segment) => segment.kind === "paste");
  }

  private insertReplyAheadOfPaste(chunk: Uint8Array) {
    // Jump the unsent paste chunks but stay behind any interactive/reply already
    // queued ahead of them; never touches the in-flight (already-shifted) write.
    const index = this.fifo.findIndex((segment) => segment.kind === "paste");
    const segment: Segment = { kind: "reply", data: chunk };
    if (index === -1) {
      this.fifo.push(segment);
    } else {
      this.fifo.splice(index, 0, segment);
    }
  }

  private ensureDraining() {
    if (this.draining || this.fifo.length === 0) {
      return;
    }
    this.draining = true;
    void this.drainLoop();
  }

  private async drainLoop() {
    try {
      while (this.fifo.length > 0) {
        const segment = this.fifo.shift()!;
        try {
          await this.write(segment.data);
        } catch (error) {
          this.onWriteError?.(error);
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
