import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { CheckCircle2Icon, DownloadIcon, Loader2Icon, XIcon } from "lucide-react";
import { Button, Header } from "@/components";
import { useTranscriptionConfig } from "@/lib";
import { cn } from "@/lib/utils";

interface WhisperModel {
  id: string;
  name: string;
  sizeMb: number;
  description: string;
  downloaded: boolean;
  downloading: boolean;
}

interface DownloadProgress {
  id: string;
  downloaded: number;
  total: number;
  done: boolean;
  error: string | null;
}

/** Offered during setup; the full list is on the Meeting page. */
const SETUP_MODELS = ["base.en", "small.en", "base"];

export const WhisperSetup = () => {
  const [config, setConfig] = useTranscriptionConfig();
  const [models, setModels] = useState<WhisperModel[]>([]);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const all = await invoke<WhisperModel[]>("local_stt_list_models");
      setModels(SETUP_MODELS.flatMap((id) => all.filter((m) => m.id === id)));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
    const unlisten = listen<DownloadProgress>("local-stt-download-progress", ({ payload }) => {
      if (payload.done) {
        setProgress(({ [payload.id]: _, ...rest }) => rest);
        if (payload.error && payload.error !== "Download cancelled") setError(payload.error);
        refresh();
      } else if (payload.total > 0) {
        setProgress((prev) => ({ ...prev, [payload.id]: payload.downloaded / payload.total }));
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [refresh]);

  const download = (id: string) => {
    setError(null);
    setProgress((prev) => ({ ...prev, [id]: 0 }));
    invoke("local_stt_download_model", { id })
      .then(() => setConfig({ engine: "local", localModel: id }))
      .catch((e) => setError(String(e)));
  };

  return (
    <div className="space-y-3">
      <Header
        title="Meeting transcription"
        description="Runningbord transcribes meetings on this device with Whisper, so audio never leaves your computer. Download a model once to turn it on. You can also skip this and use a cloud speech provider later from Dev Space."
        isMainTitle
      />
      {models.map((model) => {
        const pct = progress[model.id];
        const downloading = pct !== undefined || model.downloading;
        const active = model.downloaded && config.localModel === model.id;
        return (
          <div
            key={model.id}
            className={cn(
              "flex items-center justify-between gap-4 p-4 border rounded-xl",
              active && "border-primary/50"
            )}
          >
            <div>
              <p className="text-sm font-medium">
                {model.name}{" "}
                <span className="text-xs font-normal text-muted-foreground">
                  · {model.sizeMb} MB{model.id === "base.en" ? " · Recommended" : ""}
                </span>
              </p>
              <p className="text-xs text-muted-foreground mt-1">{model.description}</p>
            </div>
            {model.downloaded ? (
              active ? (
                <span className="flex items-center gap-1 text-xs text-emerald-600 shrink-0">
                  <CheckCircle2Icon className="size-4" /> In use
                </span>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setConfig({ engine: "local", localModel: model.id })}
                >
                  Use
                </Button>
              )
            ) : downloading ? (
              <div className="flex items-center gap-2 shrink-0">
                <Loader2Icon className="size-4 animate-spin" />
                <span className="text-xs tabular-nums w-10">{Math.round((pct ?? 0) * 100)}%</span>
                <Button
                  size="icon"
                  variant="ghost"
                  title="Cancel download"
                  onClick={() => invoke("local_stt_cancel_download", { id: model.id })}
                >
                  <XIcon className="size-4" />
                </Button>
              </div>
            ) : (
              <Button size="sm" variant="outline" onClick={() => download(model.id)}>
                <DownloadIcon className="size-4" /> Download
              </Button>
            )}
          </div>
        );
      })}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
};
