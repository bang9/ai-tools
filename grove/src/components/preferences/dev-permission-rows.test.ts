import { describe, expect, it } from "vitest";
import type { DevPermissionStatus } from "../../types";
import {
  DEV_PERMISSION_ROWS,
  devPermissionStatusBadgeVariant,
  devPermissionStatusLabel,
} from "./dev-permission-rows";

describe("devPermissionStatusLabel", () => {
  const cases: [DevPermissionStatus | undefined, string][] = [
    ["granted", "Granted"],
    ["denied", "Denied"],
    ["not-determined", "Not requested"],
    ["restricted", "Restricted"],
    ["unsupported", "macOS only (unsupported)"],
    ["unknown", "Check manually"],
    [undefined, "Check manually"],
  ];

  it.each(cases)("maps %s to its label", (status, label) => {
    expect(devPermissionStatusLabel(status)).toBe(label);
  });
});

describe("devPermissionStatusBadgeVariant", () => {
  const cases: [DevPermissionStatus | undefined, string][] = [
    ["granted", "success"],
    ["denied", "danger"],
    ["restricted", "danger"],
    ["not-determined", "secondary"],
    ["unsupported", "secondary"],
    ["unknown", "secondary"],
    [undefined, "secondary"],
  ];

  it.each(cases)("maps %s to its badge variant", (status, variant) => {
    expect(devPermissionStatusBadgeVariant(status)).toBe(variant);
  });
});

describe("DEV_PERMISSION_ROWS", () => {
  it("lists the 7 permissions in spec order", () => {
    expect(DEV_PERMISSION_ROWS.map((row) => row.id)).toEqual([
      "microphone",
      "camera",
      "screen",
      "accessibility",
      "full-disk-access",
      "automation",
      "local-network",
    ]);
  });
});
