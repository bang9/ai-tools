import { app, BrowserWindow, ipcMain, shell } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RENDERER_DEV_URL =
  process.env.GROVE_RENDERER_URL ??
  process.env.VITE_DEV_SERVER_URL ??
  "http://localhost:1420";

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
  "get_commits",
  "get_working_diff",
  "get_commit_diff",
  "get_working_diff_context",
  "get_commit_diff_context",
  "get_behind_count",
  "get_env_sync",
  "list_gitignore_patterns",
]);

interface PtyOutputPayload {
  id: string;
  data: string;
}

interface GroveLogPayload {
  level: string;
  tag: string;
  message: string;
}

type NativeMethod = (...args: unknown[]) => Promise<unknown>;

type NativeAddon = Record<string, NativeMethod> & {
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

  throw new Error(
    `Failed to load grove native addon.${lastError ? ` ${String(lastError)}` : ""}`,
  );
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

function serializeArgs(
  command: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const serialized: Record<string, unknown> = { ...args };

  if (command === "save_app_config" && "config" in serialized) {
    serialized.config = JSON.stringify(serialized.config);
  }

  if (command === "set_env_sync" && "config" in serialized) {
    serialized.config = JSON.stringify(serialized.config);
  }

  if (
    command === "save_grove_preferences" &&
    "preferences" in serialized
  ) {
    serialized.preferences = JSON.stringify(serialized.preferences);
  }

  if (
    command === "open_in_ide" &&
    "ideMenuItem" in serialized
  ) {
    serialized.ideMenuItem = JSON.stringify(serialized.ideMenuItem);
  }

  if (
    command === "save_terminal_session_snapshot" &&
    "snapshot" in serialized
  ) {
    serialized.snapshot = JSON.stringify(serialized.snapshot);
  }

  if (command === "write_pty" && Array.isArray(serialized.data)) {
    serialized.data = Buffer.from(serialized.data);
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
  const candidateNames = [
    "setLogListener",
    "registerLogListener",
    "onLog",
  ] as const;

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
    trafficLightPosition: { x: 14, y: 20 },
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

  void loadRenderer(mainWindow);
  return mainWindow;
}

function registerIpcHandlers() {
  ipcMain.removeHandler("invoke");
  ipcMain.handle(
    "invoke",
    async (event, command: string, args: Record<string, unknown> = {}) => {
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

      return invokeNative(targetWindow, command, args);
    },
  );
}

app.whenReady().then(() => {
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
