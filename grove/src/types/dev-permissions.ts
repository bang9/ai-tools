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

export interface DevPermissionState {
  id: DevPermissionId;
  status: DevPermissionStatus;
}

export interface DevPermissionRequestResult {
  id: DevPermissionId;
  status: DevPermissionStatus;
  openedSystemSettings: boolean;
}
