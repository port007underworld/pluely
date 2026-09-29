import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CheckCircle2Icon, CircleAlertIcon, CircleHelpIcon, Loader2Icon } from "lucide-react";
import { Button, Header } from "@/components";
import { useApp } from "@/contexts";
import {
  checkPermission,
  getPlatform,
  openPermissionSettings,
  PermissionKind,
  PermissionState,
  requestPermission,
} from "@/lib";

type AudioCheck = "idle" | "checking" | "receiving" | "silent" | "off" | "error";

const StateIcon = ({ state }: { state: PermissionState | "receiving" | "silent" }) =>
  state === "granted" || state === "receiving" ? (
    <CheckCircle2Icon className="size-4 text-emerald-600" />
  ) : state === "missing" || state === "silent" ? (
    <CircleAlertIcon className="size-4 text-amber-600" />
  ) : (
    <CircleHelpIcon className="size-4 text-muted-foreground" />
  );

const Row = ({
  title,
  description,
  status,
  statusText,
  children,
}: {
  title: string;
  description: string;
  status: PermissionState | "receiving" | "silent";
  statusText: string;
  children: React.ReactNode;
}) => (
  <div className="flex items-start justify-between gap-4 p-3 border rounded-lg">
    <div className="flex gap-2">
      <div className="mt-0.5">
        <StateIcon state={status} />
      </div>
      <div>
        <p className="text-sm font-medium">
          {title} <span className="text-xs font-normal text-muted-foreground">· {statusText}</span>
        </p>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
    </div>
    <div className="flex gap-2 shrink-0">{children}</div>
  </div>
);

export const Permissions = () => {
  const { systemAudioDaemonConfig, systemAudioError } = useApp();
  const [screen, setScreen] = useState<PermissionState>("unknown");
  const [mic, setMic] = useState<PermissionState>("unknown");
  const [audio, setAudio] = useState<AudioCheck>("idle");

  const refresh = useCallback(async () => {
    setScreen(await checkPermission("screen"));
    setMic(await checkPermission("microphone"));
  }, []);

  useEffect(() => {
    refresh();
    // Users grant access in System Settings, then come back.
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);

  if (getPlatform() !== "macos") return null;

  const grant = async (kind: Exclude<PermissionKind, "systemAudio">) => {
    await requestPermission(kind);
    setTimeout(refresh, 1500);
  };

  const checkAudio = async () => {
    if (!systemAudioDaemonConfig.enabled) {
      setAudio("off");
      return;
    }
    setAudio("checking");
    try {
      await new Promise((r) => setTimeout(r, 3000));
      const ratio = await invoke<number>("system_audio_silence_ratio", { seconds: 3 });
      setAudio(ratio >= 0.97 ? "silent" : "receiving");
    } catch {
      setAudio("error");
    }
  };

  const label = (state: PermissionState) =>
    state === "granted" ? "Granted" : state === "missing" ? "Not granted" : "Unknown";

  const audioStatus =
    audio === "receiving" ? "receiving" : audio === "silent" || audio === "error" ? "silent" : "unknown";
  const audioText = {
    idle: "Not checked",
    checking: "Listening…",
    receiving: "Receiving audio",
    silent: "Only silence",
    off: "Turn on Meeting mode first",
    error: systemAudioError ?? "Capture not running",
  }[audio];

  return (
    <div id="permissions" className="space-y-3">
      <Header
        title="Permissions"
        description="What macOS allows Runningbord to capture. If something is granted but still doesn't work, remove the app from the list in System Settings, add it again and restart. This usually happens after installing a differently signed build."
        isMainTitle
      />

      <Row
        title="Screen Recording"
        description="Needed for the screenshot shortcut. macOS asks you to restart the app after granting."
        status={screen}
        statusText={label(screen)}
      >
        {screen !== "granted" && (
          <Button size="sm" variant="outline" onClick={() => grant("screen")}>
            Grant
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => openPermissionSettings("screen")}>
          Open Settings
        </Button>
      </Row>

      <Row
        title="System Audio Recording"
        description="Needed to transcribe the other people in a meeting (macOS 14.2 or later). There's no way to query it directly, so play some audio and press Check."
        status={audioStatus}
        statusText={audioText}
      >
        <Button size="sm" variant="outline" onClick={checkAudio} disabled={audio === "checking"}>
          {audio === "checking" ? <Loader2Icon className="size-3.5 animate-spin" /> : "Check"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => openPermissionSettings("systemAudio")}>
          Open Settings
        </Button>
      </Row>
      {audio === "silent" && (
        <p className="text-xs text-amber-700 dark:text-amber-400 -mt-1 pl-1">
          If audio was playing, macOS is probably withholding it: allow Runningbord under System
          Audio Recording, then turn Meeting mode off and on again.
        </p>
      )}

      <Row
        title="Microphone"
        description='Only needed for "Also capture my microphone" on the Meeting page.'
        status={mic}
        statusText={label(mic)}
      >
        {mic !== "granted" && (
          <Button size="sm" variant="outline" onClick={() => grant("microphone")}>
            Grant
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => openPermissionSettings("microphone")}>
          Open Settings
        </Button>
      </Row>
    </div>
  );
};
