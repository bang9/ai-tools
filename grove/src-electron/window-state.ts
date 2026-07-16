import { app, screen } from "electron";
import type { BrowserWindow } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isFiniteRect, rectIsUsableOnDisplays, type Rect } from "./window-state-bounds";

// Tauri parity: the Tauri shell restores window size/position/fullscreen via
// tauri-plugin-window-state. Electron has no built-in equivalent, so persist
// the same state manually. Without this the app always opens at the default
// window size, where the px-based pane minSizes clamp the restored panel
// ratios (see resizable-panel-group.tsx).

export interface PersistedWindowState {
  bounds?: Rect;
  maximized: boolean;
  fullscreen: boolean;
}

const SAVE_DEBOUNCE_MS = 500;

function stateFilePath(): string {
  return path.join(app.getPath("userData"), "window-state.json");
}

export function loadWindowState(): PersistedWindowState {
  try {
    const parsed = JSON.parse(
      readFileSync(stateFilePath(), "utf8"),
    ) as Partial<PersistedWindowState>;

    const workAreas = screen.getAllDisplays().map((display) => display.workArea);
    const bounds =
      isFiniteRect(parsed.bounds) && rectIsUsableOnDisplays(parsed.bounds, workAreas)
        ? parsed.bounds
        : undefined;

    return {
      bounds,
      maximized: parsed.maximized === true,
      fullscreen: parsed.fullscreen === true,
    };
  } catch {
    return { maximized: false, fullscreen: false };
  }
}

function captureWindowState(win: BrowserWindow): PersistedWindowState {
  return {
    // getNormalBounds reports the pre-maximize/pre-fullscreen frame, so the
    // windowed size survives quitting from a maximized or fullscreen state.
    bounds: win.getNormalBounds(),
    maximized: win.isMaximized(),
    fullscreen: win.isFullScreen(),
  };
}

function saveWindowState(win: BrowserWindow) {
  if (win.isDestroyed()) {
    return;
  }

  try {
    writeFileSync(stateFilePath(), JSON.stringify(captureWindowState(win)));
  } catch (error) {
    console.error("[grove-electron] Failed to save window state:", error);
  }
}

export function trackWindowState(win: BrowserWindow) {
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleSave = () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveWindowState(win);
    }, SAVE_DEBOUNCE_MS);
  };

  win.on("resize", scheduleSave);
  win.on("move", scheduleSave);
  win.on("maximize", scheduleSave);
  win.on("unmaximize", scheduleSave);
  win.on("enter-full-screen", scheduleSave);
  win.on("leave-full-screen", scheduleSave);

  // Synchronous final save — the debounced timer may still be pending when the
  // user quits right after a resize.
  win.on("close", () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    saveWindowState(win);
  });
}
