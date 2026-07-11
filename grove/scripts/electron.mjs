import { build, context } from "esbuild";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, copyFile, mkdir, readdir, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const electronOutDir = path.join(projectRoot, ".electron");
const nativeSourceDir = path.join(projectRoot, "src-electron", "native");
const nativeOutDir = path.join(electronOutDir, "native");
const mainEntry = path.join(projectRoot, "src-electron", "main.ts");
const preloadEntry = path.join(projectRoot, "src-electron", "preload.ts");
const mainOutput = path.join(electronOutDir, "main.js");
const preloadOutput = path.join(electronOutDir, "preload.cjs");
const nativeAddonOutput = path.join(nativeOutDir, "grove-electron-native.node");
const rendererDevUrl = process.env.GROVE_RENDERER_URL ?? "http://localhost:1420";
const rendererUrl = new URL(rendererDevUrl);
const rendererHost = process.env.GROVE_RENDERER_HOST ?? rendererUrl.hostname;
const rendererPort = Number.parseInt(
  process.env.GROVE_RENDERER_PORT ?? (rendererUrl.port || "1420"),
  10,
);
const appVersion = process.env.GROVE_APP_VERSION?.trim() || "";
const buildVersion = process.env.GROVE_BUILD_VERSION?.trim() || "";
const electronDirOnly = process.env.GROVE_ELECTRON_DIR_ONLY === "1";
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function withElectronEnv(extraEnv = {}) {
  return {
    ...process.env,
    GROVE_TARGET: "electron",
    ...extraEnv,
  };
}

function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? projectRoot,
    env: options.env ?? process.env,
    stdio: options.stdio ?? "inherit",
  });

  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `${command} ${args.join(" ")} exited with ${
            signal ? `signal ${signal}` : `code ${code ?? "unknown"}`
          }`,
        ),
      );
    });
  });
}

async function waitForPath(targetPath, timeoutMs = 60_000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await access(targetPath, fsConstants.F_OK);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  throw new Error(`Timed out waiting for ${targetPath}`);
}

async function waitForPort(port, host = "127.0.0.1", timeoutMs = 60_000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const isOpen = await new Promise((resolve) => {
      const socket = net.createConnection({ port, host });

      socket.once("connect", () => {
        socket.end();
        resolve(true);
      });

      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
    });

    if (isOpen) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for http://${host}:${port}`);
}

function getMainBuildOptions() {
  return {
    absWorkingDir: projectRoot,
    bundle: true,
    entryPoints: [mainEntry],
    external: ["electron"],
    format: "esm",
    logLevel: "info",
    outfile: mainOutput,
    platform: "node",
    sourcemap: true,
    target: "node20",
  };
}

function getPreloadBuildOptions() {
  return {
    absWorkingDir: projectRoot,
    bundle: true,
    entryPoints: [preloadEntry],
    external: ["electron"],
    format: "cjs",
    logLevel: "info",
    outfile: preloadOutput,
    platform: "node",
    sourcemap: true,
    target: "node20",
  };
}

async function cleanElectronOutput() {
  await rm(electronOutDir, { force: true, recursive: true });
  await mkdir(nativeOutDir, { recursive: true });
}

async function buildElectronSources() {
  await mkdir(electronOutDir, { recursive: true });
  await Promise.all([build(getMainBuildOptions()), build(getPreloadBuildOptions())]);
}

async function watchElectronSources() {
  const buildContexts = await Promise.all([
    context(getMainBuildOptions()),
    context(getPreloadBuildOptions()),
  ]);

  await Promise.all(buildContexts.map((buildContext) => buildContext.watch()));

  return async () => {
    await Promise.all(buildContexts.map((buildContext) => buildContext.dispose()));
  };
}

async function findNativeAddon() {
  const entries = await readdir(nativeSourceDir);
  const addonNames = entries
    .filter((entry) => entry.endsWith(".node"))
    .sort((left, right) => {
      if (left === "grove-electron-native.node") {
        return -1;
      }

      if (right === "grove-electron-native.node") {
        return 1;
      }

      if (left.startsWith("grove-electron-native")) {
        return -1;
      }

      if (right.startsWith("grove-electron-native")) {
        return 1;
      }

      if (left.startsWith("index.")) {
        return -1;
      }

      if (right.startsWith("index.")) {
        return 1;
      }

      return left.localeCompare(right);
    });

  if (addonNames.length === 0) {
    throw new Error("napi build completed without producing a .node artifact");
  }

  return path.join(nativeSourceDir, addonNames[0]);
}

async function buildNativeAddon(mode) {
  const args =
    mode === "release"
      ? ["exec", "napi", "build", "--platform", "--dts", "index.d.ts"]
      : ["exec", "napi", "build", "--dts", "index.d.ts"];

  await run(pnpmCommand, args, {
    cwd: nativeSourceDir,
    env: withElectronEnv(),
  });

  await mkdir(nativeOutDir, { recursive: true });
  await copyFile(await findNativeAddon(), nativeAddonOutput);
}

function spawnTracked(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? projectRoot,
    env: options.env ?? process.env,
    stdio: options.stdio ?? "inherit",
  });

  return child;
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) {
    return;
  }

  await new Promise((resolve) => {
    const onExit = () => resolve();
    child.once("exit", onExit);
    child.kill("SIGTERM");

    setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }, 5_000).unref();
  });
}

async function prepare(mode) {
  await cleanElectronOutput();
  await Promise.all([buildElectronSources(), buildNativeAddon(mode)]);
}

async function runDev() {
  await cleanElectronOutput();

  const disposeWatches = await watchElectronSources();
  const viteProcess = spawnTracked(pnpmCommand, ["exec", "vite"], {
    env: withElectronEnv(),
  });

  let electronProcess;

  const cleanup = async () => {
    await stopChild(electronProcess);
    await stopChild(viteProcess);
    await disposeWatches();
  };

  const handleSignal = (signal) => {
    void cleanup().finally(() => {
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  };

  process.once("SIGINT", () => handleSignal("SIGINT"));
  process.once("SIGTERM", () => handleSignal("SIGTERM"));

  try {
    await Promise.all([
      buildNativeAddon("debug"),
      waitForPath(mainOutput),
      waitForPath(preloadOutput),
      waitForPort(rendererPort, rendererHost),
    ]);

    electronProcess = spawnTracked(pnpmCommand, ["exec", "electron", mainOutput], {
      env: withElectronEnv({
        GROVE_RENDERER_URL: rendererDevUrl,
      }),
    });

    await new Promise((resolve, reject) => {
      electronProcess.once("error", reject);
      electronProcess.once("exit", (code, signal) => {
        if (code === 0 || signal === "SIGTERM") {
          resolve();
          return;
        }

        reject(
          new Error(
            `electron exited with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}`,
          ),
        );
      });
    });
  } finally {
    await cleanup();
  }
}

async function runBuild() {
  await run(pnpmCommand, ["exec", "tsc", "-b"], {
    env: withElectronEnv(),
  });
  await prepare("release");
  await run(pnpmCommand, ["exec", "vite", "build"], {
    env: withElectronEnv(),
  });
  const electronBuilderArgs = [
    "exec",
    "electron-builder",
    "--config",
    "electron-builder.json",
    "--publish",
    "never",
  ];

  if (electronDirOnly) {
    electronBuilderArgs.push("--dir");
  }

  if (appVersion) {
    electronBuilderArgs.push(`-c.extraMetadata.version=${appVersion}`);
    electronBuilderArgs.push(`-c.mac.bundleShortVersion=${appVersion}`);
  }

  if (buildVersion) {
    electronBuilderArgs.push(`-c.buildVersion=${buildVersion}`);
    electronBuilderArgs.push(`-c.mac.bundleVersion=${buildVersion}`);
  }

  await run(pnpmCommand, electronBuilderArgs, {
    env: withElectronEnv(),
  });
}

const command = process.argv[2] ?? "dev";

try {
  if (command === "dev") {
    await runDev();
  } else if (command === "build") {
    await runBuild();
  } else if (command === "prepare") {
    const mode = process.argv[3] === "release" ? "release" : "debug";
    await prepare(mode);
  } else {
    throw new Error(`Unsupported command '${command}'`);
  }
} catch (error) {
  console.error(`[grove-electron] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
