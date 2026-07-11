import { describe, expect, it } from "vitest";
import { COALESCE_MAX, PtyInputQueue, isQueryReply, splitPasteInput } from "./terminal-input-queue";

/**
 * Manual microtask scheduler: captures the pending interactive-flush so tests
 * can assert pre-flush accumulation and then run the boundary explicitly.
 */
function manualScheduler() {
  let pending: (() => void) | null = null;
  return {
    schedule: (drain: () => void) => {
      pending = drain;
    },
    runMicrotask: () => {
      const drain = pending;
      pending = null;
      drain?.();
    },
    get hasPending() {
      return pending !== null;
    },
  };
}

/**
 * A `write` whose promises resolve only when the test releases them, in order.
 * Records every batch handed to `write`.
 */
function controllableWrite() {
  const batches: Uint8Array[] = [];
  const resolvers: Array<() => void> = [];
  return {
    write: (data: Uint8Array) => {
      batches.push(data);
      return new Promise<void>((resolve) => resolvers.push(resolve));
    },
    batches,
    get writeCount() {
      return batches.length;
    },
    /** Resolve the oldest still-pending write and let microtasks settle. */
    async release() {
      const resolve = resolvers.shift();
      resolve?.();
      await Promise.resolve();
      await Promise.resolve();
    },
    async releaseAll() {
      while (resolvers.length > 0) {
        await this.release();
      }
    },
  };
}

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

const enc = new TextEncoder();
const PASTE_START = enc.encode("\x1b[200~");
const PASTE_END = enc.encode("\x1b[201~");

function u8concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

describe("PtyInputQueue interactive coalescing", () => {
  it("coalesces chunks enqueued in the same burst into one write", async () => {
    const w = controllableWrite();
    const scheduler = manualScheduler();
    const queue = new PtyInputQueue({ write: w.write, schedule: scheduler.schedule });

    queue.enqueue(bytes(1, 2));
    queue.enqueue(bytes(3));
    queue.enqueue(bytes(4, 5));

    expect(w.writeCount).toBe(0);
    scheduler.runMicrotask();

    expect(w.writeCount).toBe(1);
    expect(w.batches[0]).toEqual(bytes(1, 2, 3, 4, 5));
  });

  it("preserves the exact byte stream across a burst", async () => {
    const w = controllableWrite();
    const scheduler = manualScheduler();
    const queue = new PtyInputQueue({ write: w.write, schedule: scheduler.schedule });

    const chunks = [bytes(0x1b, 0x5b, 0x41), bytes(0x68, 0x69), bytes(0x0d)];
    for (const chunk of chunks) queue.enqueue(chunk);
    scheduler.runMicrotask();

    expect(w.batches[0]).toEqual(bytes(0x1b, 0x5b, 0x41, 0x68, 0x69, 0x0d));
  });

  it("flushes on a chunk boundary before exceeding the cap without splitting", async () => {
    const w = controllableWrite();
    const scheduler = manualScheduler();
    const queue = new PtyInputQueue({
      write: w.write,
      schedule: scheduler.schedule,
      maxBytes: 4,
    });

    queue.enqueue(bytes(1, 2, 3)); // pending = 3
    queue.enqueue(bytes(4, 5)); // 3 + 2 > 4 -> boundary flush of [1,2,3]; buffer [4,5]

    expect(w.writeCount).toBe(1);
    expect(w.batches[0]).toEqual(bytes(1, 2, 3));

    await w.release();
    scheduler.runMicrotask();
    await w.release();
    expect(w.writeCount).toBe(2);
    expect(w.batches[1]).toEqual(bytes(4, 5));
  });

  it("flushes a single chunk at/over the cap immediately and whole", () => {
    const w = controllableWrite();
    const scheduler = manualScheduler();
    const queue = new PtyInputQueue({
      write: w.write,
      schedule: scheduler.schedule,
      maxBytes: 4,
    });

    queue.enqueue(bytes(1, 2, 3, 4, 5, 6));

    expect(w.writeCount).toBe(1);
    expect(w.batches[0]).toEqual(bytes(1, 2, 3, 4, 5, 6));
    expect(scheduler.hasPending).toBe(false);
  });

  it("ignores empty chunks", () => {
    const w = controllableWrite();
    const scheduler = manualScheduler();
    const queue = new PtyInputQueue({ write: w.write, schedule: scheduler.schedule });

    queue.enqueue(new Uint8Array(0));
    expect(scheduler.hasPending).toBe(false);
    scheduler.runMicrotask();
    expect(w.writeCount).toBe(0);
  });

  it("defaults the interactive cap to COALESCE_MAX", () => {
    const w = controllableWrite();
    const scheduler = manualScheduler();
    const queue = new PtyInputQueue({ write: w.write, schedule: scheduler.schedule });

    queue.enqueue(new Uint8Array(COALESCE_MAX));
    expect(w.writeCount).toBe(1);
    expect(w.batches[0].length).toBe(COALESCE_MAX);
  });
});

describe("splitPasteInput", () => {
  it("splits a large paste into <=chunkBytes pieces that concatenate exactly", () => {
    const input = enc.encode("x".repeat(50));
    const chunks = splitPasteInput(input, { chunkBytes: 10 });
    expect(chunks.length).toBe(5);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(10);
    expect(u8concat(chunks)).toEqual(input);
  });

  it("never splits inside a multi-byte CJK code point", () => {
    // "世界" repeated; each char is 3 UTF-8 bytes. chunkBytes=4 forces a boundary
    // that would land mid-character if not code-point aligned.
    const input = enc.encode("世界世界世界");
    const chunks = splitPasteInput(input, { chunkBytes: 4 });
    expect(u8concat(chunks)).toEqual(input);
    // Each chunk must decode without replacement characters (no bisected point).
    const dec = new TextDecoder("utf-8", { fatal: true });
    for (const c of chunks) {
      expect(() => dec.decode(c)).not.toThrow();
    }
  });

  it("never splits inside a 4-byte emoji code point", () => {
    const input = enc.encode("😀😀😀😀"); // 4 bytes each
    const chunks = splitPasteInput(input, { chunkBytes: 5 });
    expect(u8concat(chunks)).toEqual(input);
    const dec = new TextDecoder("utf-8", { fatal: true });
    for (const c of chunks) expect(() => dec.decode(c)).not.toThrow();
  });

  it("never bisects the bracketed-paste start/end markers", () => {
    const body = enc.encode("A".repeat(20));
    const input = u8concat([PASTE_START, body, PASTE_END]);
    const chunks = splitPasteInput(input, { chunkBytes: 8 });
    expect(u8concat(chunks)).toEqual(input);
    // No chunk boundary may fall strictly inside either marker.
    let offset = 0;
    const boundaries = new Set<number>();
    for (const c of chunks) {
      boundaries.add(offset);
      offset += c.length;
    }
    for (const markerStart of [0, PASTE_START.length + body.length]) {
      for (let inside = 1; inside < 6; inside++) {
        expect(boundaries.has(markerStart + inside)).toBe(false);
      }
    }
  });

  it("lets a marker ride alone when the chunk budget is smaller than it", () => {
    const body = enc.encode("B".repeat(10));
    const input = u8concat([PASTE_START, body]);
    const chunks = splitPasteInput(input, { chunkBytes: 3 });
    expect(u8concat(chunks)).toEqual(input);
    // The 6-byte marker cannot be bisected, so the first chunk is the whole marker.
    expect(chunks[0]).toEqual(PASTE_START);
  });

  it("truncates at a UTF-8 boundary when over the ceiling", () => {
    // 10 three-byte chars = 30 bytes; ceiling 20 cannot land mid-character.
    const input = enc.encode("世".repeat(10));
    const chunks = splitPasteInput(input, { chunkBytes: 100, ceilingBytes: 20 });
    const out = u8concat(chunks);
    expect(out.length).toBe(18); // largest multiple of 3 <= 20
    const dec = new TextDecoder("utf-8", { fatal: true });
    expect(() => dec.decode(out)).not.toThrow();
    // Concatenation equals the post-ceiling input (its truncated prefix).
    expect(out).toEqual(input.subarray(0, 18));
  });

  it("does not truncate a marker when the ceiling straddles it", () => {
    const head = enc.encode("C".repeat(10));
    const input = u8concat([head, PASTE_START, head]); // marker starts at byte 10
    // Ceiling 13 lands inside the marker (10..16); must back up to byte 10.
    const chunks = splitPasteInput(input, { chunkBytes: 100, ceilingBytes: 13 });
    const out = u8concat(chunks);
    expect(out.length).toBe(10);
    expect(out).toEqual(head);
  });

  it("appends a synthetic close marker when the ceiling strands an opener", () => {
    // Opener + large body + closer; the ceiling cuts deep inside the body, so
    // the retained prefix has ESC[200~ with no ESC[201~ — the shell would stay
    // in bracketed-paste mode without the synthetic closer.
    const body = enc.encode("D".repeat(100));
    const input = u8concat([PASTE_START, body, PASTE_END]);
    const chunks = splitPasteInput(input, { chunkBytes: 16, ceilingBytes: 40 });
    const out = u8concat(chunks);
    expect(out.subarray(0, 6)).toEqual(PASTE_START);
    expect(out.subarray(out.length - 6)).toEqual(PASTE_END);
    // Retained body (40 - 6 opener bytes) + both markers.
    expect(out.length).toBe(40 + 6);
  });

  it("does not append a closer when the truncated prefix is balanced", () => {
    // A complete bracketed paste followed by plain text; the ceiling cuts in
    // the trailing text, so the retained markers are balanced.
    const paste = u8concat([PASTE_START, enc.encode("ok"), PASTE_END]);
    const tail = enc.encode("E".repeat(50));
    const input = u8concat([paste, tail]);
    const chunks = splitPasteInput(input, { chunkBytes: 100, ceilingBytes: 30 });
    const out = u8concat(chunks);
    expect(out).toEqual(input.subarray(0, 30));
  });
});

describe("isQueryReply", () => {
  it("matches CPR, DECXCPR, primary/secondary DA, and DSR-ok exactly", () => {
    expect(isQueryReply(enc.encode("\x1b[12;34R"))).toBe(true); // CPR
    expect(isQueryReply(enc.encode("\x1b[?12;34;1R"))).toBe(true); // DECXCPR
    expect(isQueryReply(enc.encode("\x1b[?1;2c"))).toBe(true); // primary DA
    expect(isQueryReply(enc.encode("\x1b[?62;1;6c"))).toBe(true); // primary DA
    expect(isQueryReply(enc.encode("\x1b[>0;276;0c"))).toBe(true); // secondary DA
    expect(isQueryReply(enc.encode("\x1b[0n"))).toBe(true); // DSR-ok
  });

  it("does NOT match arrow keys or user ESC sequences", () => {
    expect(isQueryReply(enc.encode("\x1b[A"))).toBe(false); // up arrow
    expect(isQueryReply(enc.encode("\x1b[B"))).toBe(false);
    expect(isQueryReply(enc.encode("\x1b[1;5C"))).toBe(false); // ctrl-right
    expect(isQueryReply(enc.encode("\x1bOP"))).toBe(false); // F1
    expect(isQueryReply(enc.encode("\x1b[3~"))).toBe(false); // delete
    expect(isQueryReply(enc.encode("hi"))).toBe(false);
    expect(isQueryReply(new Uint8Array(0))).toBe(false);
  });

  it("rejects oversize and non-ASCII payloads", () => {
    expect(isQueryReply(enc.encode(`\x1b[${"1".repeat(70)}R`))).toBe(false);
    expect(
      isQueryReply(u8concat([enc.encode("\x1b[0"), bytes(0xe4, 0xb8, 0x96), enc.encode("n")])),
    ).toBe(false);
  });
});

describe("PtyInputQueue paste pacing", () => {
  it("issues chunk N+1 only after chunk N's write resolves", async () => {
    const w = controllableWrite();
    const scheduler = manualScheduler();
    const queue = new PtyInputQueue({
      write: w.write,
      schedule: scheduler.schedule,
      directThreshold: 4,
      chunkBytes: 4,
    });

    const paste = enc.encode("x".repeat(16)); // 4 chunks of 4
    queue.enqueue(paste);

    expect(w.writeCount).toBe(1); // only the first chunk is in flight
    await w.release();
    expect(w.writeCount).toBe(2);
    await w.release();
    expect(w.writeCount).toBe(3);
    await w.releaseAll();
    expect(w.writeCount).toBe(4);
    expect(u8concat(w.batches)).toEqual(paste);
  });

  it("keeps interactive input BEHIND unsent paste chunks (Enter after paste)", async () => {
    const w = controllableWrite();
    const scheduler = manualScheduler();
    const queue = new PtyInputQueue({
      write: w.write,
      schedule: scheduler.schedule,
      directThreshold: 4,
      chunkBytes: 4,
    });

    const paste = enc.encode("x".repeat(12)); // 3 chunks
    queue.enqueue(paste);
    queue.enqueue(enc.encode("\r")); // Enter typed during the paste drain
    scheduler.runMicrotask(); // flush the interactive buffer

    await w.releaseAll();

    const order = w.batches.map((b) => new TextDecoder().decode(b));
    expect(order).toEqual(["xxxx", "xxxx", "xxxx", "\r"]);
  });

  it("lets a query reply jump ahead of unsent paste chunks", async () => {
    const w = controllableWrite();
    const scheduler = manualScheduler();
    const queue = new PtyInputQueue({
      write: w.write,
      schedule: scheduler.schedule,
      directThreshold: 4,
      chunkBytes: 4,
    });

    queue.enqueue(enc.encode("x".repeat(16))); // 4 chunks; chunk 1 in flight
    queue.enqueue(enc.encode("\x1b[12;34R")); // CPR reply mid-paste

    await w.releaseAll();

    const order = w.batches.map((b) => new TextDecoder().decode(b));
    // Reply lands right after the in-flight chunk, ahead of the 3 unsent chunks.
    expect(order).toEqual(["xxxx", "\x1b[12;34R", "xxxx", "xxxx", "xxxx"]);
  });

  it("does NOT let an arrow key jump ahead of unsent paste chunks", async () => {
    const w = controllableWrite();
    const scheduler = manualScheduler();
    const queue = new PtyInputQueue({
      write: w.write,
      schedule: scheduler.schedule,
      directThreshold: 4,
      chunkBytes: 4,
    });

    queue.enqueue(enc.encode("x".repeat(12))); // 3 chunks
    queue.enqueue(enc.encode("\x1b[A")); // up arrow — interactive, not a reply
    scheduler.runMicrotask();

    await w.releaseAll();

    const order = w.batches.map((b) => new TextDecoder().decode(b));
    expect(order).toEqual(["xxxx", "xxxx", "xxxx", "\x1b[A"]);
  });

  it("bounds queued bytes on a slow backend without dropping anything", async () => {
    const w = controllableWrite();
    const scheduler = manualScheduler();
    const queue = new PtyInputQueue({
      write: w.write,
      schedule: scheduler.schedule,
      directThreshold: 4,
      chunkBytes: 4,
    });

    const paste = enc.encode("x".repeat(4000)); // 1000 chunks
    queue.enqueue(paste);

    // Only one chunk is ever in flight; the rest wait — never dropped.
    expect(w.writeCount).toBe(1);
    // Queued bytes are the unsent remainder, bounded by the paste size.
    expect(queue.queuedBytes).toBeLessThanOrEqual(paste.length);
    expect(queue.queuedBytes).toBe(paste.length - 4);

    await w.releaseAll();
    expect(w.writeCount).toBe(1000);
    expect(queue.queuedBytes).toBe(0);
    expect(u8concat(w.batches)).toEqual(paste);
  });

  it("reports write errors and keeps draining", async () => {
    const errors: unknown[] = [];
    let call = 0;
    const resolvers: Array<() => void> = [];
    const queue = new PtyInputQueue({
      write: () => {
        call += 1;
        const shouldReject = call === 1;
        return new Promise<void>((resolve, reject) => {
          resolvers.push(shouldReject ? () => reject(new Error("frozen")) : resolve);
        });
      },
      onWriteError: (e) => errors.push(e),
      directThreshold: 4,
      chunkBytes: 4,
    });

    queue.enqueue(enc.encode("x".repeat(8))); // 2 chunks

    // Reject the first write; the loop must swallow it and issue the second.
    resolvers.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(errors.length).toBe(1);
    expect(call).toBe(2);
    resolvers.shift()?.();
  });

  it("does not treat a payload at the direct threshold as a paste", () => {
    const w = controllableWrite();
    const scheduler = manualScheduler();
    const queue = new PtyInputQueue({
      write: w.write,
      schedule: scheduler.schedule,
      directThreshold: 8,
      chunkBytes: 4,
      maxBytes: 8,
    });

    queue.enqueue(new Uint8Array(8)); // == threshold -> interactive, whole
    expect(w.writeCount).toBe(1);
    expect(w.batches[0].length).toBe(8);
  });
});
