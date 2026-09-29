import { useApp } from "@/contexts";
import {
  formatDuration,
  LONG_MONOLOGUE_MS,
  summarizeTalk,
  useSessionStats,
  useTranscriptionConfig,
} from "@/lib";
import { cn } from "@/lib/utils";

/** Talking more than this share of the time turns the bar amber. */
const HIGH_SHARE = 0.6;

/**
 * A thin bar along the bottom of the overlay showing your share of the talking,
 * amber when you're dominating or in a long stretch. Hover for the numbers.
 */
export const TalkTimeBar = () => {
  const { systemAudioDaemonConfig } = useApp();
  const [config] = useTranscriptionConfig();
  const enabled =
    systemAudioDaemonConfig.enabled && config.engine === "local" && config.live && config.captureMic;
  const stats = useSessionStats(enabled, 5000);
  if (!enabled || !stats) return null;

  const summary = summarizeTalk(stats);
  if (summary.youShare === null) return null;
  const longStretch = summary.currentMonologueMs > LONG_MONOLOGUE_MS;
  const warn = summary.youShare > HIGH_SHARE || longStretch;
  const title = [
    `You've talked ${Math.round(summary.youShare * 100)}% of the time (${formatDuration(summary.youMs)} vs ${formatDuration(summary.othersMs)}).`,
    summary.wordsPerMinute ? `Pace: ${summary.wordsPerMinute} words a minute.` : "",
    longStretch ? `You've been talking for ${formatDuration(summary.currentMonologueMs)} straight.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="absolute left-3 right-3 bottom-0.5 h-1 rounded-full bg-muted/60 overflow-hidden" title={title}>
      <div
        className={cn(
          "h-full rounded-full transition-all duration-700",
          warn ? "bg-amber-500" : "bg-primary/70",
          longStretch && "animate-pulse"
        )}
        style={{ width: `${Math.round(summary.youShare * 100)}%` }}
      />
    </div>
  );
};
