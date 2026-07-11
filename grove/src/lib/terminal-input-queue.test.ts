import { describe, expect, it, vi } from "vitest";
import { COALESCE_MAX, PtyInputQueue } from "./terminal-input-queue";

/**
 * Manual microtask scheduler: captures the pending drain so tests can assert
 * pre-flush accumulation and then run the boundary explicitly.
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

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

describe("PtyInputQueue", () => {
  it("coalesces chunks enqueued in the same burst into one flush", () => {
    const flush = vi.fn<(data: Uint8Array) => void>();
    const scheduler = manualScheduler();
    const queue = new PtyInputQueue({ flush, schedule: scheduler.schedule });

    queue.enqueue(bytes(1, 2));
    queue.enqueue(bytes(3));
    queue.enqueue(bytes(4, 5));

    expect(flush).not.toHaveBeenCalled();
    scheduler.runMicrotask();

    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush.mock.calls[0][0]).toEqual(bytes(1, 2, 3, 4, 5));
  });

  it("preserves the exact byte stream across a burst", () => {
    const seen: number[] = [];
    const scheduler = manualScheduler();
    const queue = new PtyInputQueue({
      flush: (data) => seen.push(...data),
      schedule: scheduler.schedule,
    });

    const chunks = [bytes(0x1b, 0x5b, 0x41), bytes(0x68, 0x69), bytes(0x0d)];
    for (const chunk of chunks) queue.enqueue(chunk);
    scheduler.runMicrotask();

    expect(seen).toEqual([0x1b, 0x5b, 0x41, 0x68, 0x69, 0x0d]);
  });

  it("flushes on a chunk boundary before exceeding the cap without splitting", () => {
    const flush = vi.fn<(data: Uint8Array) => void>();
    const scheduler = manualScheduler();
    const queue = new PtyInputQueue({
      flush,
      schedule: scheduler.schedule,
      maxBytes: 4,
    });

    queue.enqueue(bytes(1, 2, 3)); // pending = 3
    queue.enqueue(bytes(4, 5)); // 3 + 2 > 4 -> boundary flush of [1,2,3], then buffer [4,5]

    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush.mock.calls[0][0]).toEqual(bytes(1, 2, 3));

    scheduler.runMicrotask();
    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush.mock.calls[1][0]).toEqual(bytes(4, 5));
  });

  it("flushes a single chunk at/over the cap immediately and whole", () => {
    const flush = vi.fn<(data: Uint8Array) => void>();
    const scheduler = manualScheduler();
    const queue = new PtyInputQueue({
      flush,
      schedule: scheduler.schedule,
      maxBytes: 4,
    });

    queue.enqueue(bytes(1, 2, 3, 4, 5, 6));

    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush.mock.calls[0][0]).toEqual(bytes(1, 2, 3, 4, 5, 6));
    expect(scheduler.hasPending).toBe(false);
  });

  it("emits batches in enqueue order across a cap flush", () => {
    const batches: Uint8Array[] = [];
    const scheduler = manualScheduler();
    const queue = new PtyInputQueue({
      flush: (data) => batches.push(data),
      schedule: scheduler.schedule,
      maxBytes: 4,
    });

    queue.enqueue(bytes(1, 2, 3)); // buffered
    queue.enqueue(bytes(4, 5)); // boundary flush [1,2,3]; buffer [4,5]
    queue.enqueue(bytes(6)); // buffer [4,5,6]
    scheduler.runMicrotask();

    expect(batches).toEqual([bytes(1, 2, 3), bytes(4, 5, 6)]);
  });

  it("ignores empty chunks", () => {
    const flush = vi.fn<(data: Uint8Array) => void>();
    const scheduler = manualScheduler();
    const queue = new PtyInputQueue({ flush, schedule: scheduler.schedule });

    queue.enqueue(new Uint8Array(0));
    expect(scheduler.hasPending).toBe(false);
    scheduler.runMicrotask();
    expect(flush).not.toHaveBeenCalled();
  });

  it("defaults the cap to COALESCE_MAX", () => {
    const flush = vi.fn<(data: Uint8Array) => void>();
    const scheduler = manualScheduler();
    const queue = new PtyInputQueue({ flush, schedule: scheduler.schedule });

    queue.enqueue(new Uint8Array(COALESCE_MAX));
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush.mock.calls[0][0].length).toBe(COALESCE_MAX);
  });
});
