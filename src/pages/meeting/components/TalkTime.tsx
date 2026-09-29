import { Header } from "@/components";
import {
  FAST_PACE_WPM,
  formatDuration,
  LONG_MONOLOGUE_MS,
  speakerDisplayName,
  summarizeTalk,
  useSessionStats,
  useSpeakerNames,
  useTranscriptionConfig,
} from "@/lib";
import { cn } from "@/lib/utils";

const Stat = ({ label, value, warn }: { label: string; value: string; warn?: boolean }) => (
  <div className="rounded-lg border p-3">
    <p className="text-[11px] text-muted-foreground">{label}</p>
    <p className={cn("text-lg font-semibold tabular-nums", warn && "text-amber-600 dark:text-amber-400")}>
      {value}
    </p>
  </div>
);

export const TalkTime = () => {
  const [config] = useTranscriptionConfig();
  const available = config.engine === "local" && config.live;
  const stats = useSessionStats(available);
  const names = useSpeakerNames();
  if (!available) return null;

  const summary = stats ? summarizeTalk(stats) : null;
  const total = (summary?.youMs ?? 0) + (summary?.othersMs ?? 0);

  return (
    <div id="talk-time" className="space-y-3">
      <Header
        title="Talk Time"
        description="How much you've talked compared with everyone else, how fast, and for how long at a stretch. Needs “Also capture my microphone”, since your share comes from your own mic. A thin bar under the overlay shows your share during the meeting."
        isMainTitle
      />
      {!config.captureMic ? (
        <p className="text-sm text-muted-foreground">
          Turn on “Also capture my microphone” above to measure your talk time.
        </p>
      ) : !summary || total === 0 ? (
        <p className="text-sm text-muted-foreground">Numbers appear once people start talking.</p>
      ) : (
        <>
          <div className="space-y-1.5">
            {[
              { label: "You", ms: summary.youMs, you: true },
              ...(stats?.speakers ?? [])
                .filter((s) => s.source === "system")
                .map((s) => ({ label: speakerDisplayName(s.label, names), ms: s.talkMs, you: false })),
            ].map((row) => (
              <div key={row.label} className="flex items-center gap-3 text-xs">
                <span className="w-24 truncate">{row.label}</span>
                <div className="h-2 flex-1 rounded-full bg-muted overflow-hidden">
                  <div
                    className={cn("h-full rounded-full", row.you ? "bg-primary" : "bg-muted-foreground/50")}
                    style={{ width: `${(row.ms / total) * 100}%` }}
                  />
                </div>
                <span className="w-24 text-right tabular-nums text-muted-foreground">
                  {Math.round((row.ms / total) * 100)}% · {formatDuration(row.ms)}
                </span>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Stat
              label="Your pace"
              value={summary.wordsPerMinute ? `${summary.wordsPerMinute} wpm` : "—"}
              warn={(summary.wordsPerMinute ?? 0) > FAST_PACE_WPM}
            />
            <Stat
              label="Longest stretch"
              value={formatDuration(summary.longestMonologueMs)}
              warn={summary.longestMonologueMs > LONG_MONOLOGUE_MS}
            />
            <Stat
              label="Talking now"
              value={summary.currentMonologueMs ? formatDuration(summary.currentMonologueMs) : "—"}
              warn={summary.currentMonologueMs > LONG_MONOLOGUE_MS}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            A comfortable pace is roughly 130–160 words a minute. In sales and discovery calls,
            listening more than you talk usually works better; in interviews, keep single answers
            under about two minutes.
          </p>
        </>
      )}
    </div>
  );
};
