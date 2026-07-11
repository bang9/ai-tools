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
  | "full-disk-access";

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
];

const PRIVACY_PANE_URLS: Partial<Record<DevPermissionId, string>> = {
  camera: "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera",
  microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  "full-disk-access": "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
};

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
