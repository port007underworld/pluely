import { useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { ClipboardCopyIcon, FolderOpenIcon, Loader2Icon } from "lucide-react";
import { Button, Header } from "@/components";
import { collectDiagnostics, logFilePath } from "@/lib";

export const Diagnostics = () => {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);

  const copy = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await writeText(await collectDiagnostics());
      setMessage({ text: "Copied. Paste it into a GitHub issue or message; nothing was sent anywhere." });
    } catch (e) {
      setMessage({ text: `Couldn't copy: ${e}`, error: true });
    } finally {
      setBusy(false);
    }
  };

  const openFolder = async () => {
    try {
      await revealItemInDir(await logFilePath());
    } catch (e) {
      setMessage({ text: `Couldn't open the log folder: ${e}`, error: true });
    }
  };

  return (
    <div id="diagnostics" className="space-y-3">
      <Header
        title="Diagnostics"
        description="If something isn't working, copy a report and include it when you ask for help. It has the app version, your settings (which provider and model, not API keys), recent request errors and timings, and the end of the local log. It never includes prompts, answers or transcripts, and nothing is sent anywhere."
        isMainTitle
      />
      <div className="flex flex-wrap gap-2">
        <Button onClick={copy} disabled={busy}>
          {busy ? <Loader2Icon className="size-4 animate-spin" /> : <ClipboardCopyIcon className="size-4" />}
          Copy diagnostics
        </Button>
        <Button variant="outline" onClick={openFolder}>
          <FolderOpenIcon className="size-4" /> Open log folder
        </Button>
      </div>
      {message && (
        <p className={`text-xs ${message.error ? "text-destructive" : "text-muted-foreground"}`}>{message.text}</p>
      )}
    </div>
  );
};
