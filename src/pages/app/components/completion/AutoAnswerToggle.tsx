import { MessageCircleQuestionIcon } from "lucide-react";
import { Button } from "@/components";
import { useApp } from "@/contexts";
import { shortcutLabel, useTranscriptionConfig } from "@/lib";

/**
 * Shown while Meeting mode is on with live transcription: turns automatic
 * answers to other participants' questions on or off.
 */
export const AutoAnswerToggle = () => {
  const { systemAudioDaemonConfig } = useApp();
  const [config, setConfig] = useTranscriptionConfig();
  if (!systemAudioDaemonConfig.enabled || config.engine !== "local" || !config.live) return null;

  const on = config.autoAnswer;
  const key = shortcutLabel("toggle_auto_answer");
  const keyHint = key ? ` (${key})` : "";

  return (
    <Button
      size="icon"
      variant={on ? "default" : "ghost"}
      className="relative cursor-pointer"
      aria-pressed={on}
      title={
        on
          ? `Auto-answer on: questions from others are answered when they stop speaking. Click to turn off${keyHint}.`
          : `Auto-answer off. Click to answer others' questions automatically${keyHint}.`
      }
      onClick={() => setConfig({ autoAnswer: !on })}
    >
      <MessageCircleQuestionIcon className={`h-4 w-4 ${on ? "" : "opacity-60"}`} />
      {on && (
        <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-sky-500 ring-2 ring-background" />
      )}
    </Button>
  );
};
