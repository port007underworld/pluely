import { useEffect, useState } from "react";
import { Header, Label, Switch } from "@/components";
import { useTranscriptionConfig } from "@/lib";
import { UseSettingsReturn } from "@/types";

export const MeetingModeSettings = ({
  systemAudioDaemonConfig,
  handleSystemAudioDaemonEnabledChange,
  handleSystemAudioDaemonBufferSecondsChange,
}: UseSettingsReturn) => {
  const [transcription] = useTranscriptionConfig();
  const liveTranscription = transcription.engine === "local" && transcription.live;

  const [bufferInput, setBufferInput] = useState(String(systemAudioDaemonConfig.bufferSeconds ?? 30));
  useEffect(() => {
    setBufferInput(String(systemAudioDaemonConfig.bufferSeconds ?? 30));
  }, [systemAudioDaemonConfig.bufferSeconds]);

  return (
    <div id="meeting-mode" className="space-y-3">
      <Header
        title="1. Meeting mode"
        description="While on, Runningbord listens to your computer's audio (the other people in a call), plus your microphone if you enable it below, and transcribes it. Nothing leaves your machine until you press the shortcut. Needs macOS 14.2+ on Mac."
        isMainTitle
      />
      <div className="flex items-center justify-between rounded-lg border border-input/50 p-3">
        <Label className="text-sm font-medium">Meeting mode</Label>
        <Switch
          checked={systemAudioDaemonConfig.enabled}
          onCheckedChange={handleSystemAudioDaemonEnabledChange}
        />
      </div>

      {systemAudioDaemonConfig.enabled && liveTranscription && (
        <p className="text-xs text-muted-foreground">
          Live transcription is on, so how much conversation is sent is set under{" "}
          <em>Send with each shortcut press</em> below.
        </p>
      )}
      {systemAudioDaemonConfig.enabled && !liveTranscription && (
        <div className="flex items-center justify-between gap-2">
          <div>
            <Label className="text-sm">Audio sent per shortcut (seconds)</Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              The most recent seconds of audio that get transcribed or attached when you press the
              shortcut (5–300).
            </p>
          </div>
          <input
            type="number"
            min={5}
            max={300}
            value={bufferInput}
            onChange={(e) => setBufferInput(e.target.value)}
            onBlur={(e) => {
              const v = parseInt(e.target.value, 10);
              const finalValue = Number.isNaN(v) ? 30 : Math.min(300, Math.max(5, v));
              setBufferInput(String(finalValue));
              handleSystemAudioDaemonBufferSecondsChange(finalValue);
            }}
            className="h-9 w-20 rounded-md border border-input bg-background px-2 text-sm"
          />
        </div>
      )}
    </div>
  );
};
