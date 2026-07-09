import { useSyncExternalStore } from "react";

/**
 * Detects whether any blocking overlay UI is open (Radix dialogs and
 * popper-based surfaces). The native browser webview is drawn on top of the
 * DOM, so it must hide itself while an overlay is up.
 *
 * Selectors:
 * - `[data-radix-popper-content-wrapper]` — popovers, tooltips, dropdown/context
 *   menus, selects (any Radix popper surface).
 * - `[data-slot="dialog-overlay"]` and `[role="dialog"]` — Radix dialogs
 *   (see src/components/ui/dialog.tsx).
 *
 * Toasts are intentionally NOT matched: the toast container (see
 * src/components/ui/toast.tsx / toaster.tsx) renders a plain fixed div with no
 * dialog role or popper wrapper, so it never triggers this hook.
 */
const OVERLAY_SELECTOR =
  '[data-radix-popper-content-wrapper], [data-slot="dialog-overlay"], [role="dialog"]';

let observer: MutationObserver | null = null;
let currentPresence = false;
const listeners = new Set<() => void>();

function compute(): boolean {
  if (typeof document === "undefined") return false;
  return document.body.querySelectorAll(OVERLAY_SELECTOR).length > 0;
}

function recompute(): void {
  const next = compute();
  if (next === currentPresence) return;
  currentPresence = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!observer && typeof MutationObserver !== "undefined") {
    // Radix portals attach/detach their container as a direct child of
    // <body>, so watching body's childList catches every overlay open/close
    // without the churn of a subtree observer over terminal/webview DOM.
    currentPresence = compute();
    observer = new MutationObserver(recompute);
    observer.observe(document.body, { childList: true });
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && observer) {
      observer.disconnect();
      observer = null;
    }
  };
}

function getSnapshot(): boolean {
  return currentPresence;
}

function getServerSnapshot(): boolean {
  return false;
}

export function useOverlayPresence(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
