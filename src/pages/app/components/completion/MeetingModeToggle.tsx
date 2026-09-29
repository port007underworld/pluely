import { Button } from "@/components";
import { useApp } from "@/contexts";
import { Volume2Icon, VolumeXIcon } from "lucide-react";

/**
 * Toggle for the passive system audio daemon (record last N seconds of system audio;
 * attach to chat via shortcut, e.g. Cmd+Shift+A).
 */
export const SystemAudioDaemonToggle = () => {
  const { systemAudioDaemonConfig, setSystemAudioDaemonConfig, systemAudioError } = useApp();
  const enabled = systemAudioDaemonConfig.enabled;

  const toggle = () => {
    setSystemAudioDaemonConfig((prev) => ({ ...prev, enabled: !prev.enabled }));
  };

  return (
    <Button
      size="icon"
      variant={enabled ? (systemAudioError ? "destructive" : "default") : "ghost"}
      className="cursor-pointer"
      title={
        enabled && systemAudioError
          ? `System audio capture failed: ${systemAudioError}`
          : enabled
          ? `System audio capture on (last ${systemAudioDaemonConfig.bufferSeconds}s). Shortcut to attach.`
          : "Enable system audio capture to include meeting audio with screenshots"
      }
      onClick={toggle}
    >
      {enabled ? (
        <Volume2Icon className="h-4 w-4" />
      ) : (
        <VolumeXIcon className="h-4 w-4" />
      )}
    </Button>
  );
};
