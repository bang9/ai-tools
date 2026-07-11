import {
  Accessibility,
  Camera,
  HardDrive,
  Mic,
  MonitorUp,
  Network,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type { DevPermissionId, DevPermissionStatus } from "../../types";

export interface DevPermissionRow {
  id: DevPermissionId;
  label: string;
  description: string;
  actionLabel: string;
  icon: LucideIcon;
}

export const DEV_PERMISSION_ROWS: DevPermissionRow[] = [
  {
    id: "microphone",
    label: "Microphone",
    description:
      "Voice input, transcription, and audio-recording CLIs launched from Grove terminals.",
    actionLabel: "Request",
    icon: Mic,
  },
  {
    id: "camera",
    label: "Camera",
    description: "Webcam capture and camera-driven local test apps.",
    actionLabel: "Request",
    icon: Camera,
  },
  {
    id: "screen",
    label: "Screen Recording",
    description: "Screenshot, visual automation, and UI inspection tools.",
    actionLabel: "Open Settings",
    icon: MonitorUp,
  },
  {
    id: "accessibility",
    label: "Accessibility",
    description: "Keystroke injection, window control, and UI automation tools.",
    actionLabel: "Request",
    icon: Accessibility,
  },
  {
    id: "full-disk-access",
    label: "Full Disk Access",
    description:
      "Stops per-folder prompts when terminals or file views touch macOS-protected folders (Desktop, Documents, Downloads).",
    actionLabel: "Open Settings",
    icon: HardDrive,
  },
  {
    id: "automation",
    label: "Automation",
    description:
      "Apple Events for AppleScript and scripts that control other apps (Grove's Terminal.app theme detection uses this).",
    actionLabel: "Trigger Prompt",
    icon: Workflow,
  },
  {
    id: "local-network",
    label: "Local Network",
    description: "Discovery and access for development servers on your network.",
    actionLabel: "Trigger Prompt",
    icon: Network,
  },
];

export function devPermissionStatusLabel(status: DevPermissionStatus | undefined): string {
  switch (status) {
    case "granted":
      return "Granted";
    case "denied":
      return "Denied";
    case "not-determined":
      return "Not requested";
    case "restricted":
      return "Restricted";
    case "unsupported":
      return "macOS only (unsupported)";
    case "unknown":
    case undefined:
      return "Check manually";
  }
}

export type DevPermissionBadgeVariant = "success" | "danger" | "secondary";

export function devPermissionStatusBadgeVariant(
  status: DevPermissionStatus | undefined,
): DevPermissionBadgeVariant {
  if (status === "granted") {
    return "success";
  }
  if (status === "denied" || status === "restricted") {
    return "danger";
  }
  return "secondary";
}
