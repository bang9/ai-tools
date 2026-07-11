import { error } from "./logger";

// Why: xterm's WriteBuffer._innerWrite invokes write-completion callbacks with
// no try/catch; a synchronous throw skips the loop's tail re-schedule, and
// write() only re-arms processing when the buffer is EMPTY — which a stalled
// buffer never is again. One escaping throw therefore permanently wedges the
// pane: output stops rendering and later writes only enqueue. Guard each
// completion step so a throw degrades to "continue" and never skips the tail
// re-schedule that re-arms the WriteBuffer. Verified against the vendored
// @xterm/xterm 6.0.0 in terminal-write-callback-guard.test.ts.
const MAX_REPORTS_PER_CONTEXT = 5;
const reportCountsByContext = new Map<string, number>();

/**
 * Run one step of a write-completion callback so a synchronous throw cannot
 * escape into xterm's WriteBuffer. Steps are guarded individually so an earlier
 * step's failure cannot starve a later step (e.g. the next chunk's re-write).
 * Reporting is rate-limited per context to avoid flooding the console when a
 * step throws on every write.
 */
export function runGuardedWriteCompletionStep(context: string, step: () => void): void {
  try {
    step();
  } catch (err: unknown) {
    const reported = reportCountsByContext.get(context) ?? 0;
    if (reported >= MAX_REPORTS_PER_CONTEXT) {
      return;
    }
    reportCountsByContext.set(context, reported + 1);
    error("terminal", `write-completion step "${context}" threw`, err);
  }
}

export function _resetWriteCompletionReportsForTests(): void {
  reportCountsByContext.clear();
}
