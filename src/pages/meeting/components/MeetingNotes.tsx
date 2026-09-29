import { useNavigate } from "react-router-dom";
import { FileTextIcon, Loader2Icon } from "lucide-react";
import { Button, Header, Switch } from "@/components";
import { useMeetingNotes } from "@/hooks";
import { useTranscriptionConfig } from "@/lib";

export const MeetingNotes = () => {
  const navigate = useNavigate();
  const [config, setConfig] = useTranscriptionConfig();
  const { status, generate } = useMeetingNotes();
  const available = config.engine === "local" && config.live;

  return (
    <div id="meeting-notes" className="space-y-3">
      <Header
        title="Meeting Notes"
        description="A summary, decisions and action items written from the live transcript, saved in Chats together with the transcript."
        isMainTitle
      />

      <div className="flex items-start justify-between gap-4 p-4 border rounded-xl">
        <div>
          <p className="text-sm font-medium">Write notes when Meeting mode is turned off</p>
          <p className="text-xs text-muted-foreground mt-1">
            {available
              ? "Only for meetings of two minutes or more. The whole transcript is sent to your AI provider in one request."
              : "Needs on-device transcription with Live transcription turned on (above)."}
          </p>
        </div>
        <Switch
          checked={config.meetingNotes}
          disabled={!available}
          onCheckedChange={(meetingNotes) => setConfig({ meetingNotes })}
        />
      </div>

      <div className="flex items-center justify-between gap-4 p-4 border rounded-xl">
        <div className="min-w-0">
          <p className="text-sm font-medium">Notes for the current or last meeting</p>
          <p
            className={`text-xs mt-1 ${status.state === "error" ? "text-destructive" : "text-muted-foreground"}`}
          >
            {status.state === "working"
              ? "Writing notes…"
              : status.state === "error"
              ? status.error
              : status.state === "saved"
              ? `Saved as "${status.notes.title}".`
              : "Works during a meeting too, for what's been said so far."}
          </p>
        </div>
        {status.state === "saved" ? (
          <Button
            variant="outline"
            className="shrink-0"
            onClick={() => navigate(`/chats/view/${status.notes.conversationId}`)}
          >
            <FileTextIcon className="size-4" /> Open notes
          </Button>
        ) : (
          <Button
            variant="outline"
            className="shrink-0"
            disabled={!available || status.state === "working"}
            onClick={generate}
          >
            {status.state === "working" ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : (
              <FileTextIcon className="size-4" />
            )}
            Generate now
          </Button>
        )}
      </div>
    </div>
  );
};
