import { Button } from "@/components";
import { useApp } from "@/contexts";
import { AudioLinesIcon } from "lucide-react";

/**
 * Meeting mode toggle: listens to meeting audio (and optionally the mic) and
 * transcribes it so the screenshot shortcut can include what was said.
 */
export const MeetingModeToggle = () => {
  const { systemAudioDaemonConfig, setSystemAudioDaemonConfig, systemAudioError } = useApp();
  const enabled = systemAudioDaemonConfig.enabled;
  const failed = enabled && Boolean(systemAudioError);

  const toggle = () => {
    setSystemAudioDaemonConfig((prev) => ({ ...prev, enabled: !prev.enabled }));
  };

  return (
    <Button
      size="icon"
      variant={failed ? "destructive" : enabled ? "default" : "ghost"}
      className="relative cursor-pointer"
      aria-pressed={enabled}
      title={
        failed
          ? `Meeting mode couldn't start: ${systemAudioError}`
          : enabled
          ? "Meeting mode on: listening to the meeting. Press the screenshot shortcut to include what was said."
          : "Turn on Meeting mode to include what's said in the meeting with screenshots"
      }
      onClick={toggle}
    >
      <AudioLinesIcon className={`h-4 w-4 ${enabled ? "" : "opacity-60"}`} />
      {enabled && !failed && (
        <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-emerald-500 ring-2 ring-background animate-pulse" />
      )}
    </Button>
  );
};
