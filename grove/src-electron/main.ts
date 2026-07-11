import { app, BrowserWindow, clipboard, ipcMain, Menu, shell, WebContentsView } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RENDERER_DEV_URL =
  process.env.GROVE_RENDERER_URL ?? process.env.VITE_DEV_SERVER_URL ?? "http://localhost:1420";

const JSON_RESPONSE_COMMANDS = new Set([
  "get_terminal_theme",
  "get_app_config",
  "get_grove_preferences",
  "get_process_env_diagnostics",
  "list_projects",
  "add_project",
  "create_project",
  "refresh_project",
  "add_worktree",
  "add_stacked_worktree",
  "list_worktrees",
  "get_worktree_pr_url",
  "create_pty",
  "poll_pty_bells",
  "save_terminal_session_snapshot",
  "load_terminal_session_snapshot",
  "run_terminal_gc",
  "get_status",
  "list_directory_files",
  "list_directory_files_deep",
  "read_workspace_file",
  "get_commits",
  "get_working_diff",
  "get_commit_diff",
  "get_working_diff_context",
  "get_commit_diff_context",
  "get_behind_count",
  "get_remote_branches",
  "get_env_sync",
  "list_gitignore_patterns",
  "list_missions",
  "create_mission",
  "add_project_to_mission",
  "list_notes",
]);

interface PtyOutputPayload {
  id: string;
  // Raw PTY bytes as a Node Buffer from the native addon; forwarded unchanged
  // to the renderer, where structured clone delivers a Uint8Array.
  data: Uint8Array;
}

interface GroveLogPayload {
  level: string;
  tag: string;
  message: string;
}

type NativeMethod = (...args: unknown[]) => Promise<unknown>;

type NativeAddon = Record<string, NativeMethod> & {
  installPanicHook(): void;
  createPty(
    ptyId: string,
    paneId: string,
    worktreePath: string,
    cwd: string,
    cols: number,
    rows: number,
    restore: string | null | undefined,
    onOutput: (error: Error | null, payload?: PtyOutputPayload) => void,
  ): Promise<string>;
};

function loadNativeAddon(): NativeAddon {
  const candidates = [
    path.join(__dirname, "native"),
    path.join(__dirname, "native", "grove-electron-native.node"),
    path.join(__dirname, "..", "target", "napi-native-v2"),
    path.join(__dirname, "..", "target", "napi-native"),
  ];

  let lastError: unknown;

  for (const candidate of candidates) {
    const isNodeAddon = candidate.endsWith(".node");
    if (!isNodeAddon && !existsSync(candidate)) {
      continue;
    }

    try {
      return require(candidate) as NativeAddon;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`Failed to load grove native addon.${lastError ? ` ${String(lastError)}` : ""}`);
}

const native = loadNativeAddon();

function toNativeMethodName(command: string): string {
  return command.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function parseJsonResult(command: string, value: unknown): unknown {
  if (!JSON_RESPONSE_COMMANDS.has(command) || value == null) {
    return value;
  }

  if (typeof value !== "string") {
    throw new Error(`Expected JSON string result for '${command}'`);
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(
      `Failed to parse JSON result for '${command}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function serializeArgs(command: string, args: Record<string, unknown>): Record<string, unknown> {
  const serialized: Record<string, unknown> = { ...args };

  if (command === "save_app_config" && "config" in serialized) {
    serialized.config = JSON.stringify(serialized.config);
  }

  if (command === "set_env_sync" && "config" in serialized) {
    serialized.config = JSON.stringify(serialized.config);
  }

  if (command === "save_grove_preferences" && "preferences" in serialized) {
    serialized.preferences = JSON.stringify(serialized.preferences);
  }

  if (command === "open_in_ide" && "ideMenuItem" in serialized) {
    serialized.ideMenuItem = JSON.stringify(serialized.ideMenuItem);
  }

  if (command === "save_terminal_session_snapshot" && "snapshot" in serialized) {
    serialized.snapshot = JSON.stringify(serialized.snapshot);
  }

  if (command === "write_pty" && ArrayBuffer.isView(serialized.data)) {
    // The renderer now sends a Uint8Array (structured-cloned across IPC), which
    // is not Array.isArray. napi's Buffer binding rejects a bare TypedArray, so
    // wrap it as a Node Buffer (Buffer.from over a Uint8Array copies the bytes).
    serialized.data = Buffer.from(serialized.data as Uint8Array);
  }

  return serialized;
}

function serializeCreatePtyRestore(args: Record<string, unknown>) {
  if (!Object.prototype.hasOwnProperty.call(args, "restore")) {
    return undefined;
  }

  const restore = args.restore;
  if (restore == null) {
    return restore;
  }

  return JSON.stringify(restore);
}

function requireStringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string") {
    throw new Error(`Expected string argument '${key}'`);
  }

  return value;
}

function requireNumberArg(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`Expected numeric argument '${key}'`);
  }

  return value;
}

function requireBooleanArg(args: Record<string, unknown>, key: string): boolean {
  const value = args[key];
  if (typeof value !== "boolean") {
    throw new Error(`Expected boolean argument '${key}'`);
  }

  return value;
}

interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

function requireBoundsArg(args: Record<string, unknown>): BrowserBounds {
  const raw = args.bounds;
  if (!raw || typeof raw !== "object") {
    throw new Error("Expected object argument 'bounds'");
  }

  const bounds = raw as Record<string, unknown>;
  return {
    x: requireNumberArg(bounds, "x"),
    y: requireNumberArg(bounds, "y"),
    width: requireNumberArg(bounds, "width"),
    height: requireNumberArg(bounds, "height"),
  };
}

function roundBounds(bounds: BrowserBounds): BrowserBounds {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  };
}

function isAllowedBrowserUrl(url: string): boolean {
  if (url === "about:blank") {
    return true;
  }

  try {
    const parsed = new URL(url);
    // file: backs local HTML previews opened from the file viewer.
    return (
      parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "file:"
    );
  } catch {
    return false;
  }
}

// --- Browser tab (native webview) support ---

interface BrowserTabEntry {
  view: WebContentsView;
  window: BrowserWindow;
}

const browserViews = new Map<string, BrowserTabEntry>();

const BROWSER_COMMANDS = new Set([
  "browser_create",
  "browser_navigate",
  "browser_go_back",
  "browser_go_forward",
  "browser_reload",
  "browser_set_bounds",
  "browser_set_visible",
  "browser_close",
  "browser_close_all",
  "browser_open_devtools",
]);

function sendBrowserNav(
  win: BrowserWindow,
  tabId: string,
  view: WebContentsView,
  loadingOverride?: boolean,
) {
  if (win.isDestroyed() || win.webContents.isDestroyed()) {
    return;
  }

  const wc = view.webContents;
  if (wc.isDestroyed()) {
    return;
  }

  win.webContents.send("browser:nav", {
    tabId,
    url: wc.getURL(),
    title: wc.getTitle() || null,
    loading: loadingOverride ?? wc.isLoading(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
  });
}

function wireBrowserViewEvents(win: BrowserWindow, tabId: string, view: WebContentsView) {
  const wc = view.webContents;

  wc.on("did-start-loading", () => sendBrowserNav(win, tabId, view));
  wc.on("did-stop-loading", () => sendBrowserNav(win, tabId, view));
  wc.on("did-navigate", () => sendBrowserNav(win, tabId, view));
  wc.on("did-navigate-in-page", () => sendBrowserNav(win, tabId, view));
  wc.on("page-title-updated", () => sendBrowserNav(win, tabId, view));
  wc.on("did-fail-load", () => sendBrowserNav(win, tabId, view, false));

  wc.setWindowOpenHandler(({ url }) => {
    // target="_blank" links / window.open: never load in this view or open a
    // native window — the frontend opens a Grove browser tab instead. Only
    // http/https URLs are forwarded ("about:blank" is allowed for
    // navigation but not a real new-window request).
    if (
      url !== "about:blank" &&
      isAllowedBrowserUrl(url) &&
      !win.isDestroyed() &&
      !win.webContents.isDestroyed()
    ) {
      win.webContents.send("browser:new-window", { openerTabId: tabId, url });
    }
    return { action: "deny" };
  });

  wc.on("will-navigate", (event, url) => {
    if (!isAllowedBrowserUrl(url)) {
      event.preventDefault();
    }
  });

  // Right-click menu on the browser guest. Built as a NATIVE menu (not a
  // renderer React menu): the WebContentsView is a native layer painted over
  // the DOM, so a DOM menu would render *under* the page and be invisible.
  wc.on("context-menu", (_event, params) => {
    if (win.isDestroyed() || wc.isDestroyed()) {
      return;
    }

    const linkUrl = params.linkURL && isAllowedBrowserUrl(params.linkURL) ? params.linkURL : null;
    const pageUrl = wc.getURL();
    const template: MenuItemConstructorOptions[] = [];

    if (linkUrl) {
      template.push(
        {
          label: "Open Link in New Tab",
          click: () => {
            if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
              win.webContents.send("browser:new-window", { openerTabId: tabId, url: linkUrl });
            }
          },
        },
        {
          label: "Copy Link Address",
          click: () => clipboard.writeText(linkUrl),
        },
        { type: "separator" },
      );
    }

    if (params.selectionText) {
      template.push(
        {
          label: "Copy",
          click: () => clipboard.writeText(params.selectionText),
        },
        { type: "separator" },
      );
    }

    template.push(
      {
        label: "Back",
        enabled: wc.navigationHistory.canGoBack(),
        click: () => {
          if (!wc.isDestroyed() && wc.navigationHistory.canGoBack()) {
            wc.navigationHistory.goBack();
          }
        },
      },
      {
        label: "Forward",
        enabled: wc.navigationHistory.canGoForward(),
        click: () => {
          if (!wc.isDestroyed() && wc.navigationHistory.canGoForward()) {
            wc.navigationHistory.goForward();
          }
        },
      },
      {
        label: "Reload",
        click: () => {
          if (!wc.isDestroyed()) {
            wc.reload();
          }
        },
      },
      { type: "separator" },
      {
        label: "Copy Page URL",
        enabled: !!pageUrl,
        click: () => clipboard.writeText(pageUrl),
      },
      {
        label: "Open Page in Default Browser",
        enabled: isAllowedBrowserUrl(pageUrl),
        click: () => {
          void shell.openExternal(pageUrl);
        },
      },
      { type: "separator" },
      {
        label: "Inspect Page",
        click: () => {
          if (wc.isDestroyed()) {
            return;
          }
          // Detached — a docked devtools would fight the manually-positioned
          // WebContentsView and overlap the app UI. inspectElement focuses the
          // element the user right-clicked.
          wc.openDevTools({ mode: "detach" });
          wc.inspectElement(params.x, params.y);
        },
      },
    );

    Menu.buildFromTemplate(template).popup({ window: win });
  });
}

function closeBrowserViewsForWindow(win: BrowserWindow) {
  for (const [tabId, entry] of browserViews) {
    if (entry.window !== win) {
      continue;
    }

    try {
      if (!win.isDestroyed()) {
        win.contentView.removeChildView(entry.view);
      }
    } catch (error) {
      console.error("[grove-electron] Failed to remove browser view:", error);
    }

    try {
      if (!entry.view.webContents.isDestroyed()) {
        entry.view.webContents.close();
      }
    } catch (error) {
      console.error("[grove-electron] Failed to close browser view webContents:", error);
    }

    browserViews.delete(tabId);
  }
}

async function handleBrowserCommand(
  targetWindow: BrowserWindow,
  command: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (command === "browser_close_all") {
    // A freshly reloaded renderer calls this once to clean up webviews
    // orphaned by its previous session (tab state is in-memory).
    closeBrowserViewsForWindow(targetWindow);
    return;
  }

  const tabId = requireStringArg(args, "tabId");

  if (command === "browser_create") {
    const url = requireStringArg(args, "url");
    if (!isAllowedBrowserUrl(url)) {
      throw new Error(`Blocked navigation to disallowed URL: ${url}`);
    }

    const existing = browserViews.get(tabId);
    if (existing && !existing.view.webContents.isDestroyed()) {
      await existing.view.webContents.loadURL(url);
      return;
    }

    const bounds = roundBounds(requireBoundsArg(args));
    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    targetWindow.contentView.addChildView(view);
    view.setBounds(bounds);
    wireBrowserViewEvents(targetWindow, tabId, view);
    browserViews.set(tabId, { view, window: targetWindow });

    await view.webContents.loadURL(url);
    return;
  }

  const entry = browserViews.get(tabId);
  if (!entry || entry.view.webContents.isDestroyed()) {
    // All commands other than browser_create are silent no-ops for unknown tabs.
    return;
  }

  const { view } = entry;
  const wc = view.webContents;

  switch (command) {
    case "browser_navigate": {
      const url = requireStringArg(args, "url");
      if (isAllowedBrowserUrl(url)) {
        void wc.loadURL(url);
      }
      return;
    }

    case "browser_go_back": {
      if (wc.navigationHistory.canGoBack()) {
        wc.navigationHistory.goBack();
      }
      return;
    }

    case "browser_go_forward": {
      if (wc.navigationHistory.canGoForward()) {
        wc.navigationHistory.goForward();
      }
      return;
    }

    case "browser_reload": {
      wc.reload();
      return;
    }

    case "browser_open_devtools": {
      // Detached window — a docked mode would fight the manually-positioned
      // WebContentsView and overlap the app UI.
      wc.openDevTools({ mode: "detach" });
      return;
    }

    case "browser_set_bounds": {
      view.setBounds(roundBounds(requireBoundsArg(args)));
      return;
    }

    case "browser_set_visible": {
      view.setVisible(requireBooleanArg(args, "visible"));
      return;
    }

    case "browser_close": {
      try {
        if (!entry.window.isDestroyed()) {
          entry.window.contentView.removeChildView(view);
        }
      } catch (error) {
        console.error("[grove-electron] Failed to remove browser view:", error);
      }

      if (!wc.isDestroyed()) {
        wc.close();
      }

      browserViews.delete(tabId);
      return;
    }

    default:
      return;
  }
}

async function invokeNative(
  targetWindow: BrowserWindow,
  command: string,
  args: Record<string, unknown>,
) {
  if (command === "create_pty") {
    const raw = await native.createPty(
      requireStringArg(args, "ptyId"),
      requireStringArg(args, "paneId"),
      requireStringArg(args, "worktreePath"),
      requireStringArg(args, "cwd"),
      requireNumberArg(args, "cols"),
      requireNumberArg(args, "rows"),
      serializeCreatePtyRestore(args),
      (error, payload) => {
        if (error) {
          console.error("[grove-electron] PTY callback error:", error);
          return;
        }

        if (!payload || targetWindow.isDestroyed()) {
          return;
        }

        targetWindow.webContents.send("pty-output", payload);
      },
    );

    return parseJsonResult(command, raw);
  }

  const methodName = toNativeMethodName(command);
  const method = native[methodName];
  if (typeof method !== "function") {
    throw new Error(`Unsupported native command '${command}'`);
  }

  const raw = await method(...Object.values(serializeArgs(command, args)));
  return parseJsonResult(command, raw);
}

function broadcast(channel: string, payload: unknown) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
  }
}

function registerOptionalLogForwarding() {
  const candidateNames = ["setLogListener", "registerLogListener", "onLog"] as const;

  for (const name of candidateNames) {
    const candidate = native[name];
    if (typeof candidate !== "function") {
      continue;
    }

    void candidate((error: Error | null, payload?: GroveLogPayload) => {
      if (error) {
        console.error("[grove-electron] log callback error:", error);
        return;
      }

      if (payload) {
        broadcast("grove:log", payload);
      }
    });
    return;
  }
}

function resolvePreloadPath() {
  const candidates = [
    path.join(__dirname, "preload.js"),
    path.join(__dirname, "preload.mjs"),
    path.join(__dirname, "preload.cjs"),
    path.join(__dirname, "preload.ts"),
  ];

  const match = candidates.find((candidate) => existsSync(candidate));
  if (!match) {
    throw new Error("Failed to resolve Electron preload entrypoint");
  }

  return match;
}

async function loadRenderer(mainWindow: BrowserWindow) {
  if (!app.isPackaged) {
    await mainWindow.loadURL(RENDERER_DEV_URL);
    return;
  }

  await mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
}

function createMainWindow() {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1024,
    minHeight: 720,
    titleBarStyle: "hiddenInset",
    // Tauri parity: tauri.conf.json uses trafficLightPosition {x:14, y:20},
    // but tao treats y as a titlebar *inset* (container height = button height
    // + y, button keeps its default 9px in-container offset), which lands the
    // button frame 20 - 9 = 11px from the window top. Electron's y is that
    // top offset directly, so y:11 renders the lights at the same position.
    trafficLightPosition: { x: 14, y: 11 },
    // Parity with tauri.conf.json acceptFirstMouse: deliver the
    // app-activating click instead of swallowing it (macOS-only).
    acceptFirstMouse: true,
    webPreferences: {
      preload: resolvePreloadPath(),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.on("enter-full-screen", () => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send("fullscreen-change", true);
    }
  });
  mainWindow.on("leave-full-screen", () => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send("fullscreen-change", false);
    }
  });
  mainWindow.on("closed", () => {
    closeBrowserViewsForWindow(mainWindow);
  });

  void loadRenderer(mainWindow);
  return mainWindow;
}

function registerIpcHandlers() {
  ipcMain.removeHandler("invoke");
  ipcMain.handle("invoke", async (event, command: string, args: Record<string, unknown> = {}) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender);
    if (!targetWindow) {
      throw new Error("Unable to resolve caller window for invoke IPC");
    }

    if (command === "is_fullscreen") {
      return targetWindow.isFullScreen();
    }

    if (command === "open_external") {
      const url = requireStringArg(args, "url");
      await shell.openExternal(url);
      return;
    }

    if (command === "reveal_in_finder") {
      const p = requireStringArg(args, "path");
      shell.openPath(p);
      return;
    }

    if (command === "open_dev_console") {
      targetWindow.webContents.openDevTools();
      return;
    }

    if (command === "reload_app_window") {
      targetWindow.webContents.reload();
      return;
    }

    if (BROWSER_COMMANDS.has(command)) {
      return handleBrowserCommand(targetWindow, command, args);
    }

    return invokeNative(targetWindow, command, args);
  });
}

app.whenReady().then(() => {
  // Route grove-core thread panics (PTY reader/flusher) into the app log
  // surface; without this they die silently on stderr.
  native.installPanicHook();
  registerIpcHandlers();
  registerOptionalLogForwarding();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
