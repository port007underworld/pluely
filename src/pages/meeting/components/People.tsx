import { useState } from "react";
import { Header, Input } from "@/components";
import { setSpeakerName, useSessionStats, useSpeakerNames, useTranscriptionConfig } from "@/lib";

const NameField = ({ label, name }: { label: string; name?: string }) => {
  const [value, setValue] = useState(name ?? "");
  const [editing, setEditing] = useState(false);
  const shown = editing ? value : name ?? "";
  return (
    <Input
      className="h-8 w-44"
      placeholder={`Name for ${label}`}
      value={shown}
      onFocus={() => {
        setValue(name ?? "");
        setEditing(true);
      }}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        setSpeakerName(label, value);
        setEditing(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
};

export const People = () => {
  const [config] = useTranscriptionConfig();
  const available = config.engine === "local" && config.live;
  const stats = useSessionStats(available);
  const names = useSpeakerNames();
  if (!available) return null;

  const others = stats?.speakers.filter((s) => s.source === "system") ?? [];

  return (
    <div id="people" className="space-y-3">
      <Header
        title="People"
        description={
          config.separateSpeakers
            ? "Voices heard in this meeting. Name them so answers, transcripts and notes use real names. Names reset when the next meeting starts."
            : 'Everyone on the call is "Them" unless Tell speakers apart is on (above). With one other person, naming them here is enough.'
        }
        isMainTitle
      />
      {others.length === 0 ? (
        <p className="text-sm text-muted-foreground">People appear here as they speak.</p>
      ) : (
        <div className="space-y-2">
          {others.map((speaker) => (
            <div
              key={speaker.label}
              className="flex items-center justify-between gap-4 p-3 border rounded-xl"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {names[speaker.label] ?? speaker.label}
                  {names[speaker.label] && (
                    <span className="ml-1 text-xs font-normal text-muted-foreground">
                      ({speaker.label})
                    </span>
                  )}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    {speaker.lines} line{speaker.lines === 1 ? "" : "s"}
                  </span>
                </p>
                <p className="text-xs text-muted-foreground mt-0.5 truncate">
                  Last said: “{speaker.lastText}”
                </p>
              </div>
              <NameField label={speaker.label} name={names[speaker.label]} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
