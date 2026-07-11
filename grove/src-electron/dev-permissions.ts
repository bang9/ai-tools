import { execFile } from "node:child_process";
import dgram from "node:dgram";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { shell, systemPreferences } from "electron";

// Local unions instead of importing from src/types: src-electron is a
// self-contained shell (see main.ts) and cannot depend on the renderer tree.
export type DevPermissionId =
  | "microphone"
  | "camera"
  | "screen"
  | "accessibility"
  | "full-disk-access"
  | "automation"
  | "local-network";

export type DevPermissionStatus =
  | "granted"
  | "denied"
  | "not-determined"
  | "restricted"
  | "unknown"
  | "unsupported";

interface DevPermissionState {
  id: DevPermissionId;
  status: DevPermissionStatus;
}

interface DevPermissionRequestResult extends DevPermissionState {
  openedSystemSettings: boolean;
}

export const DEV_PERMISSION_COMMANDS = new Set([
  "dev_permissions_status",
  "dev_permissions_request",
]);

const DEV_PERMISSION_IDS: DevPermissionId[] = [
  "microphone",
  "camera",
  "screen",
  "accessibility",
  "full-disk-access",
  "automation",
  "local-network",
];

const PRIVACY_PANE_URLS: Partial<Record<DevPermissionId, string>> = {
  camera: "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera",
  microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  "full-disk-access": "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
  automation: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
};

const APPLE_EVENTS_PROMPT_TIMEOUT_MS = 3_000;
const LOCAL_NETWORK_PROMPT_TIMEOUT_MS = 1_000;

function unsupportedOffMac(): DevPermissionStatus | null {
  return process.platform === "darwin" ? null : "unsupported";
}

function getMediaStatus(mediaType: "microphone" | "camera" | "screen"): DevPermissionStatus {
  const unsupported = unsupportedOffMac();
  if (unsupported) {
    return unsupported;
  }

  try {
    return systemPreferences.getMediaAccessStatus(mediaType) as DevPermissionStatus;
  } catch {
    return "unknown";
  }
}

async function getFullDiskAccessStatus(): Promise<DevPermissionStatus> {
  const unsupported = unsupportedOffMac();
  if (unsupported) {
    return unsupported;
  }

  try {
    // Safari bookmarks are TCC-protected, so read access is a practical Full
    // Disk Access signal without touching user project contents.
    await access(path.join(homedir(), "Library", "Safari", "Bookmarks.plist"));
    return "granted";
  } catch {
    return "unknown";
  }
}

function getAccessibilityStatus(): DevPermissionStatus {
  const unsupported = unsupportedOffMac();
  if (unsupported) {
    return unsupported;
  }

  return systemPreferences.isTrustedAccessibilityClient(false) ? "granted" : "unknown";
}

async function openPrivacyPane(id: DevPermissionId): Promise<boolean> {
  const url = PRIVACY_PANE_URLS[id];
  if (!url) {
    await shell.openExternal(
      "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension",
    );
    return true;
  }

  await shell.openExternal(url);
  return true;
}

function triggerAppleEventsPrompt(): Promise<void> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof execFile> | null = null;
    let settled = false;

    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve();
    };

    // This request only nudges macOS to show the Automation prompt; a stuck
    // osascript process must not keep the permission IPC pending.
    const timeout = setTimeout(() => {
      child?.kill();
      finish();
    }, APPLE_EVENTS_PROMPT_TIMEOUT_MS);
    if (typeof timeout.unref === "function") {
      timeout.unref();
    }

    try {
      child = execFile(
        "osascript",
        ["-e", 'tell application "System Events" to return 1'],
        { timeout: APPLE_EVENTS_PROMPT_TIMEOUT_MS },
        finish,
      );
    } catch {
      finish();
    }
  });
}

function triggerLocalNetworkPrompt(): Promise<void> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    function finish(): void {
      if (settled) {
        return;
      }
      settled = true;
      socket.removeListener("error", finish);
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      try {
        socket.close();
      } catch {
        // Already closed or never fully bound.
      }
      resolve();
    }

    socket.on("error", finish);
    socket.bind(() => {
      const message = Buffer.from([0]);
      socket.send(message, 0, message.length, 5353, "224.0.0.251", finish);
    });
    timeout = setTimeout(finish, LOCAL_NETWORK_PROMPT_TIMEOUT_MS);
    if (typeof timeout.unref === "function") {
      timeout.unref();
    }
  });
}

async function getPermissionState(id: DevPermissionId): Promise<DevPermissionState> {
  switch (id) {
    case "microphone":
    case "camera":
    case "screen":
      return { id, status: getMediaStatus(id) };
    case "accessibility":
      return { id, status: getAccessibilityStatus() };
    case "full-disk-access":
      return { id, status: await getFullDiskAccessStatus() };
    case "automation":
    case "local-network":
      return { id, status: unsupportedOffMac() ?? "unknown" };
  }
}

async function requestPermission(id: DevPermissionId): Promise<DevPermissionRequestResult> {
  if (process.platform !== "darwin") {
    return { id, status: "unsupported", openedSystemSettings: false };
  }

  if (id === "microphone" || id === "camera") {
    // askForMediaAccess only surfaces the TCC prompt when status is
    // "not-determined". After a previous denial it resolves false with no
    // prompt, so fall through to the Privacy pane so the user can toggle it.
    const granted = await systemPreferences.askForMediaAccess(id);
    if (granted) {
      return { id, status: "granted", openedSystemSettings: false };
    }

    const status = getMediaStatus(id);
    if (status === "denied" || status === "restricted" || status === "unknown") {
      await openPrivacyPane(id);
      return { id, status, openedSystemSettings: true };
    }

    return { id, status, openedSystemSettings: false };
  }

  if (id === "accessibility") {
    // isTrustedAccessibilityClient(true) shows the prompt only the first time
    // for this bundle; once dismissed or denied it's a no-op, so fall through
    // to the Privacy pane when not granted.
    const trusted = systemPreferences.isTrustedAccessibilityClient(true);
    if (trusted) {
      return { id, status: "granted", openedSystemSettings: false };
    }

    await openPrivacyPane(id);
    return { id, status: getAccessibilityStatus(), openedSystemSettings: true };
  }

  if (id === "automation") {
    await triggerAppleEventsPrompt();
    return { id, status: "unknown", openedSystemSettings: false };
  }

  if (id === "local-network") {
    await triggerLocalNetworkPrompt();
    return { id, status: "unknown", openedSystemSettings: false };
  }

  await openPrivacyPane(id);
  return { id, status: (await getPermissionState(id)).status, openedSystemSettings: true };
}

function isDevPermissionId(value: unknown): value is DevPermissionId {
  return typeof value === "string" && (DEV_PERMISSION_IDS as string[]).includes(value);
}

export async function handleDevPermissionCommand(
  command: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (command === "dev_permissions_status") {
    return Promise.all(DEV_PERMISSION_IDS.map(getPermissionState));
  }

  if (command === "dev_permissions_request") {
    const id = args.id;
    if (!isDevPermissionId(id)) {
      return { id, status: "unsupported", openedSystemSettings: false };
    }

    return requestPermission(id);
  }

  throw new Error(`Unsupported dev permission command '${command}'`);
}
