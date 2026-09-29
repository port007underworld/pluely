import { useEffect, useState } from "react";
import { check, Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdateState =
  | { status: "idle" | "checking" | "none" }
  | { status: "available" | "downloading"; version: string; notes?: string; progress?: number }
  | { status: "error"; error: string };

let state: UpdateState = { status: "idle" };
let pending: Update | null = null;
const listeners = new Set<(s: UpdateState) => void>();

const set = (next: UpdateState) => {
  state = next;
  listeners.forEach((l) => l(state));
};

/** Ask GitHub Releases for a newer signed build. `silent` keeps errors out of the UI. */
export async function checkForUpdates({ silent = false } = {}): Promise<void> {
  if (state.status === "checking" || state.status === "downloading") return;
  set({ status: "checking" });
  try {
    pending = await check();
    set(
      pending
        ? { status: "available", version: pending.version, notes: pending.body ?? undefined }
        : { status: "none" }
    );
  } catch (e) {
    pending = null;
    // Offline, or no published release yet: not worth interrupting anyone.
    set(silent ? { status: "idle" } : { status: "error", error: String(e) });
  }
}

/** Download, install and restart into the new version. */
export async function installUpdate(): Promise<void> {
  if (!pending || state.status !== "available") return;
  const { version, notes } = state;
  let total = 0;
  let received = 0;
  set({ status: "downloading", version, notes, progress: 0 });
  try {
    await pending.downloadAndInstall((event) => {
      if (event.event === "Started") total = event.data.contentLength ?? 0;
      if (event.event === "Progress") {
        received += event.data.chunkLength;
        set({ status: "downloading", version, notes, progress: total ? received / total : undefined });
      }
    });
    await relaunch();
  } catch (e) {
    set({ status: "error", error: `Update failed: ${e}` });
  }
}

const SIX_HOURS = 6 * 60 * 60 * 1000;
let started = false;

/** Check at launch and every 6 hours (once per window). Never installs on its own. */
export function startUpdateChecks(): void {
  // Dev builds (`tauri dev`) never check; releases only see newer published versions.
  if (started || import.meta.env.DEV) return;
  started = true;
  checkForUpdates({ silent: true });
  setInterval(() => checkForUpdates({ silent: true }), SIX_HOURS);
}

export function useUpdater(): UpdateState {
  const [current, setCurrent] = useState(state);
  useEffect(() => {
    listeners.add(setCurrent);
    setCurrent(state);
    return () => {
      listeners.delete(setCurrent);
    };
  }, []);
  return current;
}
