type SyncJob = {
  key: string;
  fn: () => Promise<void>;
  intervalMs: number;
  lastRun: number;
  running: boolean;
};

type StartSyncManagerOptions = {
  runImmediately?: boolean;
};

const jobs = new Map<string, SyncJob>();
let tickTimer: ReturnType<typeof setInterval> | null = null;
let started = false;

const TICK_MS = 1000;

/** Register a sync job. If key already exists, updates the config. */
export function registerSyncJob(key: string, fn: () => Promise<void>, intervalMs: number) {
  jobs.set(key, {
    key,
    fn,
    intervalMs,
    lastRun: Date.now(),
    running: false,
  });
}

/** Unregister a sync job. */
export function unregisterSyncJob(key: string) {
  jobs.delete(key);
}

/** Run a specific job immediately (non-blocking). */
export function runJobNow(key: string) {
  const job = jobs.get(key);
  if (job && !job.running) {
    executeJob(job);
  }
}

async function executeJob(job: SyncJob) {
  if (job.running) return;
  job.running = true;
  try {
    await job.fn();
  } catch {
    // Jobs handle their own errors internally
  } finally {
    job.running = false;
    job.lastRun = Date.now();
  }
}

function tick() {
  const now = Date.now();
  for (const job of jobs.values()) {
    if (job.running) continue;
    if (now - job.lastRun >= job.intervalMs) {
      // Fire and forget — non-blocking, doesn't hold up other jobs
      executeJob(job);
    }
  }
}

/** Start the global sync tick. Call once at app init. */
export function startSyncManager(options: StartSyncManagerOptions = {}) {
  if (started) return;
  started = true;

  if (options.runImmediately ?? true) {
    // Run all jobs immediately on first start
    for (const job of jobs.values()) {
      executeJob(job);
    }
  }

  tickTimer = setInterval(tick, TICK_MS);
}

/** Stop the global sync tick. */
export function stopSyncManager() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  started = false;
}
