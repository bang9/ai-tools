/**
 * PTY output routing shared by both platform transports.
 *
 * Electron delivers a single global `pty-output` event carrying the ptyId;
 * Tauri delivers raw bytes through a per-PTY `tauri::ipc::Channel` whose
 * onmessage closure carries the ptyId the channel was created for. Both funnel
 * through {@link routePtyOutput} so the owning runtime's `handlePtyOutput` runs
 * the same hydrated/ordering gate regardless of transport.
 *
 * Kept dependency-free (a leaf module) so the low-level platform layer can call
 * {@link routePtyOutput} without importing terminal-runtime, which would form an
 * import cycle (terminal-runtime -> platform -> terminal-runtime).
 */

export type PtyOutputHandler = (data: Uint8Array) => void;

const handlersByPtyId = new Map<string, PtyOutputHandler>();

/** Register the handler that receives output for a ptyId (last writer wins). */
export function setPtyOutputHandler(ptyId: string, handler: PtyOutputHandler) {
  if (!ptyId) {
    return;
  }
  handlersByPtyId.set(ptyId, handler);
}

/**
 * Remove a ptyId route, but only if `handler` is still the current owner. This
 * mirrors the previous `runtimesByPtyId.get(id) === this` guard so a runtime
 * that already handed its ptyId to another runtime (pane re-acquire / ptyId
 * reassignment) does not tear down the new owner's route.
 */
export function clearPtyOutputHandler(ptyId: string, handler: PtyOutputHandler) {
  if (!ptyId) {
    return;
  }
  if (handlersByPtyId.get(ptyId) === handler) {
    handlersByPtyId.delete(ptyId);
  }
}

/** Deliver a coalesced output chunk to the runtime that currently owns ptyId. */
export function routePtyOutput(ptyId: string, data: Uint8Array) {
  handlersByPtyId.get(ptyId)?.(data);
}
