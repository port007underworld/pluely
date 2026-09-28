import { useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, Trash2Icon } from "lucide-react";
import { Badge, Button, Header } from "@/components";
import { clearRequestLog, RequestLogEntry, useRequestLog } from "@/lib";
import { cn } from "@/lib/utils";

const kb = (bytes: number) => (bytes >= 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${bytes} B`);

const statusVariant = (status: RequestLogEntry["status"]) =>
  status === "ok" ? "secondary" : status === "error" ? "destructive" : "outline";

const Row = ({ entry }: { entry: RequestLogEntry }) => {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <div className="rounded-md border border-input/50">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left cursor-pointer hover:bg-muted/40"
      >
        <Chevron className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs tabular-nums text-muted-foreground w-16 shrink-0">
          {new Date(entry.startedAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })}
        </span>
        <Badge variant={statusVariant(entry.status)} className="text-[10px]">
          {entry.status}
        </Badge>
        <span className="text-xs truncate flex-1">{entry.promptPreview.split("\n")[0]}</span>
        <span className="text-[10px] text-muted-foreground shrink-0">
          {entry.historyMessages} hist · ~{entry.estimatedPromptTokens} tok
          {entry.images > 0 && " · img"}
          {entry.hasTranscript && " · transcript"}
          {entry.audioBytes > 0 && " · audio"} · {(entry.totalMs / 1000).toFixed(1)}s
        </span>
      </button>
      {open && (
        <div className="border-t border-input/40 px-3 py-2 space-y-2 text-xs">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
            <dt className="text-muted-foreground">Request id</dt>
            <dd className="font-mono break-all">{entry.requestId}</dd>
            <dt className="text-muted-foreground">Provider</dt>
            <dd>{entry.provider}</dd>
            <dt className="text-muted-foreground">History sent</dt>
            <dd className="font-mono">
              {entry.historyMessages} messages {entry.historyRoles && `(${entry.historyRoles})`}
            </dd>
            <dt className="text-muted-foreground">Attachments</dt>
            <dd>
              {entry.images} image(s), {kb(entry.imageBytes)}
              {entry.audioBytes > 0 && `, audio ${kb(entry.audioBytes)}`}
            </dd>
            <dt className="text-muted-foreground">Timing</dt>
            <dd>
              first text after{" "}
              {entry.timeToFirstChunkMs !== undefined ? `${entry.timeToFirstChunkMs} ms` : "—"},
              total {entry.totalMs} ms, {entry.responseChars} chars
            </dd>
            {entry.error && (
              <>
                <dt className="text-muted-foreground">Error</dt>
                <dd className="text-destructive break-words">{entry.error}</dd>
              </>
            )}
          </dl>
          <pre className="whitespace-pre-wrap rounded bg-muted/50 p-2 max-h-56 overflow-auto">
            {entry.promptPreview}
          </pre>
        </div>
      )}
    </div>
  );
};

export const RequestInspector = () => {
  const entries = useRequestLog();
  return (
    <div id="request-inspector" className="space-y-3">
      <Header
        title="Recent Requests"
        description="What was actually sent to the AI for the last 25 questions: history, attachments, transcript and timing. Stored only on this device; API keys are never recorded."
        isMainTitle
        rightSlot={
          entries.length > 0 ? (
            <Button size="sm" variant="ghost" onClick={clearRequestLog}>
              <Trash2Icon className="size-3.5" />
              Clear
            </Button>
          ) : null
        }
      />
      <div className={cn("space-y-1.5", entries.length === 0 && "hidden")}>
        {entries.map((entry) => (
          <Row key={entry.requestId + entry.startedAt} entry={entry} />
        ))}
      </div>
      {entries.length === 0 && (
        <p className="text-xs text-muted-foreground">No requests yet.</p>
      )}
    </div>
  );
};
