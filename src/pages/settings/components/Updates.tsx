import { Loader2Icon, RefreshCwIcon, DownloadIcon } from "lucide-react";
import { Button, Header } from "@/components";
import { useVersion } from "@/hooks";
import { checkForUpdates, installUpdate, useUpdater } from "@/lib";

export const Updates = () => {
  const update = useUpdater();
  const { version } = useVersion();
  const busy = update.status === "checking" || update.status === "downloading";

  const statusText = (() => {
    switch (update.status) {
      case "checking":
        return "Checking for updates…";
      case "none":
        return "You're on the latest version.";
      case "available":
        return `Version ${update.version} is available.`;
      case "downloading":
        return update.progress !== undefined
          ? `Downloading ${update.version}… ${Math.round(update.progress * 100)}%`
          : `Downloading ${update.version}…`;
      case "error":
        return update.error;
      default:
        return "Updates are checked automatically; nothing installs until you choose to.";
    }
  })();

  return (
    <div id="updates" className="space-y-3">
      <Header
        title="Updates"
        description={`You're running version ${version ?? "…"}. New versions are signed and come from this project's GitHub releases.`}
        isMainTitle
      />
      <div className="flex items-center justify-between gap-4 p-4 border rounded-xl">
        <p className={`text-sm ${update.status === "error" ? "text-destructive" : ""}`}>{statusText}</p>
        {update.status === "available" || update.status === "downloading" ? (
          <Button onClick={installUpdate} disabled={busy}>
            {busy ? <Loader2Icon className="size-4 animate-spin" /> : <DownloadIcon className="size-4" />}
            Install &amp; restart
          </Button>
        ) : (
          <Button variant="outline" onClick={() => checkForUpdates()} disabled={busy}>
            {busy ? <Loader2Icon className="size-4 animate-spin" /> : <RefreshCwIcon className="size-4" />}
            Check now
          </Button>
        )}
      </div>
      {(update.status === "available" || update.status === "downloading") && update.notes && (
        <pre className="whitespace-pre-wrap text-xs text-muted-foreground rounded-lg bg-muted/40 p-3 max-h-48 overflow-auto">
          {update.notes}
        </pre>
      )}
    </div>
  );
};
