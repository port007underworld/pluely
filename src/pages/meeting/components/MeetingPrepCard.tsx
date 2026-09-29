import { useState } from "react";
import { CheckIcon, Loader2Icon, SparklesIcon } from "lucide-react";
import { Button, Header, Switch, Textarea } from "@/components";
import { useApp } from "@/contexts";
import {
  clearPinnedFacts,
  getPersonalContext,
  getPreset,
  meetingBriefNote,
  MeetingPrep,
  pinFact,
  prepareMeeting,
  resolveAIProvider,
  selectPreset,
  setPersonalContext,
  switchProfile,
  useProfiles,
} from "@/lib";

const BRIEF_ID = "ctx_meeting_brief";

const KIND_LABEL: Record<MeetingPrep["kind"], string> = {
  interview: "Interview",
  "sales-call": "Sales call",
  "team-meeting": "Team meeting",
  other: "Meeting",
};

const Option = ({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  children: React.ReactNode;
}) => (
  <label className="flex items-start justify-between gap-3 text-sm cursor-pointer">
    <span>{children}</span>
    <Switch checked={checked} onCheckedChange={onChange} />
  </label>
);

export const MeetingPrepCard = () => {
  const { selectedAIProvider, allAiProviders, onSetSelectedAIProvider, setSystemPrompt } = useApp();
  const { profiles, activeId } = useProfiles();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prep, setPrep] = useState<MeetingPrep | null>(null);
  const [applied, setApplied] = useState(false);
  const [useProfile, setUseProfile] = useState(true);
  const [addBrief, setAddBrief] = useState(true);
  const [pinFacts, setPinFacts] = useState(true);

  const profile = prep?.profile ? profiles.find((p) => p.name === prep.profile) : undefined;
  const preset = prep && prep.kind !== "other" ? getPreset(prep.kind) : undefined;
  const profileAction = profile
    ? profile.id === activeId
      ? null
      : `Switch to your “${profile.name}” profile`
    : preset
    ? `Use the ${preset.name} prompt`
    : null;

  const prepare = async () => {
    const resolved = resolveAIProvider(selectedAIProvider, allAiProviders);
    if ("error" in resolved) {
      setError(resolved.error);
      return;
    }
    setBusy(true);
    setError(null);
    setPrep(null);
    setApplied(false);
    try {
      setPrep(
        await prepareMeeting({
          provider: resolved.provider,
          selectedProvider: selectedAIProvider,
          text,
          profiles: profiles.map((p) => p.name),
        })
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const apply = () => {
    if (!prep) return;
    try {
      if (useProfile && profileAction) {
        if (profile) {
          const result = switchProfile(profile.id, selectedAIProvider);
          setSystemPrompt(result.systemPrompt);
          if (result.ai !== selectedAIProvider) onSetSelectedAIProvider(result.ai);
        } else if (preset) {
          setSystemPrompt(selectPreset(preset.id));
        }
      }
      if (addBrief) {
        const context = getPersonalContext();
        const brief = {
          id: BRIEF_ID,
          kind: "note" as const,
          title: `Meeting brief: ${prep.title}`,
          content: meetingBriefNote(prep),
          enabled: true,
          addedAt: Date.now(),
        };
        setPersonalContext({
          enabled: true,
          items: [brief, ...context.items.filter((i) => i.id !== BRIEF_ID)],
        });
      }
      if (pinFacts && prep.facts.length > 0) {
        clearPinnedFacts();
        prep.facts.forEach(pinFact);
      }
      setApplied(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div id="meeting-prep" className="space-y-3">
      <Header
        title="Prepare for a Meeting"
        description="Paste a calendar invite, agenda, email thread or job description. Runningbord writes a short brief and can switch to the right profile, add the brief to your context and pin the key facts."
        isMainTitle
      />
      <Textarea
        placeholder="Paste the invite or agenda here…"
        className="min-h-28 text-sm"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <Button onClick={prepare} disabled={busy || !text.trim()}>
        {busy ? <Loader2Icon className="size-4 animate-spin" /> : <SparklesIcon className="size-4" />}
        {busy ? "Preparing…" : "Prepare"}
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}

      {prep && (
        <div className="space-y-4 rounded-xl border p-4">
          <div>
            <p className="text-sm font-semibold">
              {prep.title}{" "}
              <span className="text-xs font-normal text-muted-foreground">· {KIND_LABEL[prep.kind]}</span>
            </p>
            {prep.summary && <p className="text-sm text-muted-foreground mt-1">{prep.summary}</p>}
          </div>
          {prep.attendees.length > 0 && (
            <p className="text-xs">
              <span className="font-medium">Attendees: </span>
              {prep.attendees.map((a) => (a.role ? `${a.name} (${a.role})` : a.name)).join(", ")}
            </p>
          )}
          {prep.questions.length > 0 && (
            <div className="text-xs space-y-1">
              <p className="font-medium">Be ready for</p>
              <ul className="list-disc pl-5 space-y-0.5 text-muted-foreground">
                {prep.questions.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="space-y-2 border-t pt-3">
            {profileAction && (
              <Option checked={useProfile} onChange={setUseProfile}>
                {profileAction}
              </Option>
            )}
            <Option checked={addBrief} onChange={setAddBrief}>
              Add this brief to My Context (replaces the previous meeting brief)
            </Option>
            {prep.facts.length > 0 && (
              <Option checked={pinFacts} onChange={setPinFacts}>
                Pin {prep.facts.length} fact{prep.facts.length === 1 ? "" : "s"} (replaces current pins):{" "}
                <span className="text-muted-foreground">{prep.facts.join(" · ")}</span>
              </Option>
            )}
          </div>
          <Button onClick={apply} disabled={applied}>
            <CheckIcon className="size-4" /> {applied ? "Applied" : "Apply"}
          </Button>
        </div>
      )}
    </div>
  );
};
