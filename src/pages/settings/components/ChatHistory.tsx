import { useState } from "react";
import { DownloadIcon, Loader2Icon, TrashIcon } from "lucide-react";
import {
  Button,
  Header,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components";
import {
  applyRetention,
  deleteAllConversations,
  exportConversations,
  ExportFormat,
  RETENTION_OPTIONS,
  useConversationSettings,
} from "@/lib";

const retentionLabel = (days: number) => {
  if (days === 0) return "Keep forever";
  if (days === 1) return "After 1 day";
  if (days === 365) return "After 1 year";
  return `After ${days} days`;
};

export const ChatHistory = () => {
  const [settings, setSettings] = useConversationSettings();
  const [busy, setBusy] = useState<ExportFormat | "delete" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);

  const changeRetention = async (days: number) => {
    setSettings({ retentionDays: days });
    const removed = await applyRetention();
    setMessage(
      removed > 0
        ? { text: `Deleted ${removed} conversation${removed === 1 ? "" : "s"} older than the new limit.` }
        : null
    );
  };

  const runExport = async (format: ExportFormat) => {
    setBusy(format);
    setMessage(null);
    try {
      const path = await exportConversations(format);
      if (path) setMessage({ text: `Saved to ${path}` });
    } catch (error) {
      setMessage({ text: `Export failed: ${error}`, error: true });
    } finally {
      setBusy(null);
    }
  };

  const deleteAll = async () => {
    setBusy("delete");
    setMessage(null);
    try {
      await deleteAllConversations();
      setMessage({ text: "All conversations were deleted." });
    } catch (error) {
      setMessage({ text: `Delete failed: ${error}`, error: true });
    } finally {
      setBusy(null);
      setConfirmDelete(false);
    }
  };

  return (
    <div id="chat-history" className="space-y-3">
      <Header
        title="Chat History"
        description="Conversations, including meeting transcripts, are stored only on this device. Choose how long to keep them, or export them."
        isMainTitle
      />

      <div className="flex items-center justify-between gap-4 p-4 border rounded-xl">
        <div>
          <p className="text-sm font-medium">Delete old conversations</p>
          <p className="text-xs text-muted-foreground mt-1">
            Conversations not used for this long are deleted automatically.
          </p>
        </div>
        <Select
          value={String(settings.retentionDays)}
          onValueChange={(v) => changeRetention(Number(v))}
        >
          <SelectTrigger className="w-48 shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RETENTION_OPTIONS.map((d) => (
              <SelectItem key={d} value={String(d)}>
                {retentionLabel(d)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center justify-between gap-4 p-4 border rounded-xl">
        <div>
          <p className="text-sm font-medium">Export all conversations</p>
          <p className="text-xs text-muted-foreground mt-1">
            Markdown is easy to read; JSON keeps every field. Attached images aren't included.
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          {(["markdown", "json"] as const).map((format) => (
            <Button
              key={format}
              variant="outline"
              onClick={() => runExport(format)}
              disabled={busy !== null}
            >
              {busy === format ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <DownloadIcon className="size-4" />
              )}
              {format === "json" ? "JSON" : "Markdown"}
            </Button>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 p-4 border rounded-xl">
        <div>
          <p className="text-sm font-medium">Delete all conversations</p>
          <p className="text-xs text-muted-foreground mt-1">
            Permanently removes every saved conversation. This can't be undone.
          </p>
        </div>
        {confirmDelete ? (
          <div className="flex gap-2 shrink-0">
            <Button variant="outline" onClick={() => setConfirmDelete(false)} disabled={busy !== null}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={deleteAll} disabled={busy !== null}>
              {busy === "delete" ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <TrashIcon className="size-4" />
              )}
              Delete everything
            </Button>
          </div>
        ) : (
          <Button
            variant="outline"
            className="shrink-0 text-destructive"
            onClick={() => setConfirmDelete(true)}
            disabled={busy !== null}
          >
            <TrashIcon className="size-4" />
            Delete all
          </Button>
        )}
      </div>

      {message && (
        <p className={`text-xs ${message.error ? "text-destructive" : "text-muted-foreground"}`}>
          {message.text}
        </p>
      )}
    </div>
  );
};
