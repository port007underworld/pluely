import { openUrl } from "@tauri-apps/plugin-opener";
import { getPlatform } from "./platform";

export type PermissionKind = "screen" | "microphone" | "systemAudio";
export type PermissionState = "granted" | "missing" | "unknown" | "unsupported";

export const SCREEN_RECORDING_HELP =
  "Screen Recording permission is required. Enable Runningbord under System Settings › Privacy & Security › Screen & System Audio Recording, then restart the app. If it's already enabled and still fails, see Settings › Permissions.";

const SETTINGS_PANES: Record<PermissionKind, string> = {
  screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  systemAudio: "x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture",
};

const isMac = () => getPlatform() === "macos";

const macPermissions = () => import("tauri-plugin-macos-permissions-api");

export async function openPermissionSettings(kind: PermissionKind): Promise<void> {
  await openUrl(SETTINGS_PANES[kind]);
}

export async function checkPermission(kind: Exclude<PermissionKind, "systemAudio">): Promise<PermissionState> {
  if (!isMac()) return "unsupported";
  try {
    const api = await macPermissions();
    const granted =
      kind === "screen"
        ? await api.checkScreenRecordingPermission()
        : await api.checkMicrophonePermission();
    return granted ? "granted" : "missing";
  } catch {
    return "unknown";
  }
}

export async function requestPermission(kind: Exclude<PermissionKind, "systemAudio">): Promise<void> {
  if (!isMac()) return;
  const api = await macPermissions();
  if (kind === "screen") await api.requestScreenRecordingPermission();
  else await api.requestMicrophonePermission();
}

let screenRecordingConfirmed = false;

/**
 * Before a screenshot: make sure Screen Recording is granted, prompting once if
 * not. Returns false when it's still missing (caller shows SCREEN_RECORDING_HELP).
 */
export async function ensureScreenRecordingPermission(): Promise<boolean> {
  if (!isMac() || screenRecordingConfirmed) return true;
  if ((await checkPermission("screen")) === "missing") {
    await requestPermission("screen");
    await new Promise((resolve) => setTimeout(resolve, 2000));
    if ((await checkPermission("screen")) === "missing") return false;
  }
  screenRecordingConfirmed = true;
  return true;
}
