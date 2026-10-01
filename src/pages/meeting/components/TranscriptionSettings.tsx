import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useNavigate } from "react-router-dom";
import {
  CheckCircle2Icon,
  CloudIcon,
  CpuIcon,
  DownloadIcon,
  MicIcon,
  RadioIcon,
  FileAudioIcon,
  Loader2Icon,
  PlayIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import {
  Badge,
  Button,
  Header,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from "@/components";
import { useApp } from "@/contexts";
import {
  aiProviderAcceptsAudio,
  captureMeetingAudio,
  MeetingAudioCapture,
  TRANSCRIPT_WINDOWS,
  AUTO_ANSWER_DELAYS,
  TranscriptionEngine,
  useTranscriptionConfig,
  speakerDisplayName,
  useSpeakerNames,
} from "@/lib";
import { cn } from "@/lib/utils";

interface WhisperModel {
  id: string;
  name: string;
  sizeMb: number;
  multilingual: boolean;
  description: string;
  downloaded: boolean;
  downloading: boolean;
}

interface LiveSegment {
  source: "system" | "mic";
  startMs: number;
  endMs: number;
  text: string;
  speaker?: string;
}

interface SpeakerModelStatus {
  supported: boolean;
  downloaded: boolean;
  downloading: boolean;
  sizeMb: number;
}

const SPEAKER_MODEL_ID = "speaker-wespeaker-resnet34";

interface LiveStatus {
  running: boolean;
  modelId: string | null;
  segmentCount: number;
  lastError: string | null;
}

const windowLabel = (seconds: number) =>
  seconds < 60 ? `${seconds} seconds` : `${seconds / 60} minute${seconds === 60 ? "" : "s"}`;

interface DownloadProgress {
  id: string;
  downloaded: number;
  total: number;
  done: boolean;
  error: string | null;
}

const LANGUAGES: { code: string; label: string }[] = [
  { code: "auto", label: "Auto-detect" },
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "hi", label: "Hindi" },
  { code: "pt", label: "Portuguese" },
  { code: "it", label: "Italian" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "zh", label: "Chinese" },
];

const ENGINES: {
  id: TranscriptionEngine;
  title: string;
  badge: string;
  description: string;
  icon: typeof CpuIcon;
}[] = [
  {
    id: "local",
    title: "On this device",
    badge: "Private · Free",
    description:
      "Whisper runs locally. Meeting audio never leaves your computer. Needs a one-time model download.",
    icon: CpuIcon,
  },
  {
    id: "cloud",
    title: "Cloud provider",
    badge: "Opt-in",
    description:
      "Sends audio to the speech-to-text provider you configure (Google, Groq, OpenAI, Deepgram…). Best on slower machines.",
    icon: CloudIcon,
  },
  {
    id: "raw",
    title: "Raw audio",
    badge: "Advanced",
    description:
      "Attaches the audio file itself. Only works with AI providers that accept audio input, such as Gemini.",
    icon: FileAudioIcon,
  },
];

const formatMb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;

export const TranscriptionSettings = () => {
  const navigate = useNavigate();
  const {
    allSttProviders,
    selectedSttProvider,
    allAiProviders,
    selectedAIProvider,
    systemAudioDaemonConfig,
    systemAudioError,
    micError,
    micDevice,
  } = useApp();
  const [config, setConfig] = useTranscriptionConfig();
  const speakerNames = useSpeakerNames();
  const [models, setModels] = useState<WhisperModel[]>([]);
  const [progress, setProgress] = useState<Record<string, DownloadProgress>>({});
  const [modelError, setModelError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<MeetingAudioCapture | null>(null);
  const [liveStatus, setLiveStatus] = useState<LiveStatus | null>(null);
  const [liveLines, setLiveLines] = useState<LiveSegment[]>([]);
  // Words of the sentence still being spoken, per source.
  const [partials, setPartials] = useState<Partial<Record<LiveSegment["source"], string>>>({});

  const liveWanted =
    config.engine === "local" && config.live && systemAudioDaemonConfig.enabled;

  const startLive = useCallback(async () => {
    try {
      await invoke("live_transcript_start", {
        modelId: config.localModel,
        language: config.language,
      });
    } catch (e) {
      console.warn("Live transcription:", e);
    }
  }, [config.localModel, config.language]);

  useEffect(() => {
    if (!liveWanted) {
      setLiveStatus(null);
      return;
    }
    let active = true;
    const poll = async () => {
      try {
        const status = await invoke<LiveStatus>("live_transcript_status");
        if (active) setLiveStatus(status);
      } catch {}
    };
    poll();
    const timer = setInterval(poll, 2000);

    let cancelled = false;
    const unlisteners: (() => void)[] = [];
    const subscribe = <T,>(event: string, handler: (payload: T) => void) =>
      listen<T>(event, ({ payload }) => handler(payload)).then((fn) => {
        if (cancelled) fn();
        else unlisteners.push(fn);
      });
    subscribe<LiveSegment>("live-transcript-segment", (segment) => {
      setLiveLines((prev) => [...prev.slice(-5), segment]);
      setPartials((prev) => ({ ...prev, [segment.source]: undefined }));
    });
    subscribe<{ source: LiveSegment["source"]; text: string }>(
      "live-transcript-partial",
      (partial) => setPartials((prev) => ({ ...prev, [partial.source]: partial.text }))
    );
    return () => {
      active = false;
      clearInterval(timer);
      cancelled = true;
      unlisteners.forEach((fn) => fn());
    };
  }, [liveWanted]);

  // The overlay window starts the microphone (asking macOS for permission
  // first) and reports back; this page only changes the setting.
  const toggleMic = (enabled: boolean) => setConfig({ captureMic: enabled });

  const [speakerModel, setSpeakerModel] = useState<SpeakerModelStatus | null>(null);

  const refreshModels = useCallback(async () => {
    try {
      setModels(await invoke<WhisperModel[]>("local_stt_list_models"));
      setSpeakerModel(await invoke<SpeakerModelStatus>("speaker_model_status"));
    } catch (e) {
      setModelError(String(e));
    }
  }, []);

  useEffect(() => {
    refreshModels();
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<DownloadProgress>("local-stt-download-progress", ({ payload }) => {
      if (payload.done) {
        setProgress((prev) => {
          const { [payload.id]: _, ...rest } = prev;
          return rest;
        });
        if (payload.error && payload.error !== "Download cancelled") {
          setModelError(payload.error);
        }
        refreshModels();
      } else {
        setProgress((prev) => ({ ...prev, [payload.id]: payload }));
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [refreshModels]);

  const download = async (id: string) => {
    setModelError(null);
    setProgress((prev) => ({
      ...prev,
      [id]: { id, downloaded: 0, total: 0, done: false, error: null },
    }));
    // Resolves when the download finishes; progress arrives via events.
    invoke("local_stt_download_model", { id })
      .then(() => {
        const activeReady = models.some((m) => m.id === config.localModel && m.downloaded);
        if (!activeReady) setConfig({ localModel: id });
        // The live worker couldn't start without a model; start it now.
        if (liveWanted && (!activeReady || id === config.localModel)) {
          invoke("live_transcript_start", { modelId: activeReady ? config.localModel : id, language: config.language }).catch(() => {});
        }
      })
      .catch(() => {});
  };

  const cancelDownload = (id: string) => invoke("local_stt_cancel_download", { id });

  const remove = async (id: string) => {
    try {
      await invoke("local_stt_delete_model", { id });
      await refreshModels();
    } catch (e) {
      setModelError(String(e));
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(
        await captureMeetingAudio({
          windowSeconds: systemAudioDaemonConfig.bufferSeconds,
          sttProvider: allSttProviders.find((p) => p.id === selectedSttProvider.provider),
          sttSelection: selectedSttProvider,
          aiAcceptsAudio: await aiProviderAcceptsAudio(
            allAiProviders.find((p) => p.id === selectedAIProvider.provider)
          ),
        })
      );
    } finally {
      setTesting(false);
    }
  };

  const activeModel = models.find((m) => m.id === config.localModel);
  const cloudProvider = allSttProviders.find((p) => p.id === selectedSttProvider.provider);

  return (
    <div id="transcription" className="space-y-4">
      <Header
        title="2. Meeting transcription"
        description="What happens to the captured audio when you press the shortcut. Transcripts are timestamped and labelled by speaker, and they stay in the conversation for follow-up questions. Recommended: On this device, with Live transcription on."
        isMainTitle
      />

      <div className="grid gap-2 @2xl:grid-cols-3" role="radiogroup">
        {ENGINES.map((engine) => {
          const selected = config.engine === engine.id;
          const Icon = engine.icon;
          return (
            <button
              key={engine.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => setConfig({ engine: engine.id })}
              className={cn(
                "text-left rounded-lg border p-3 transition-colors cursor-pointer",
                selected
                  ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                  : "border-input/50 hover:bg-muted/40"
              )}
            >
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <div className="flex items-center gap-2">
                  <Icon className="size-4 text-primary/80" />
                  <span className="text-sm font-medium">{engine.title}</span>
                </div>
                {selected && <CheckCircle2Icon className="size-4 text-primary" />}
              </div>
              <Badge variant="secondary" className="text-[10px] mb-1.5">
                {engine.badge}
              </Badge>
              <p className="text-xs text-muted-foreground leading-snug">
                {engine.description}
              </p>
            </button>
          );
        })}
      </div>

      {config.engine !== "raw" && (
        <div className="flex items-start justify-between gap-3 rounded-lg border border-input/50 p-3">
          <div className="flex gap-2">
            <MicIcon className="size-4 mt-0.5 text-primary/80 shrink-0" />
            <div>
              <p className="text-sm font-medium">Also capture my microphone</p>
              <p className="text-xs text-muted-foreground">
                Your own speech is transcribed separately and labelled "You"; everyone else is
                "Them". Headphones give the cleanest result. Without them, echoed speaker audio is
                filtered out, but some may slip through.
              </p>
              {config.captureMic && systemAudioDaemonConfig.enabled && micDevice && !micError && (
                <p className="text-xs text-emerald-700 dark:text-emerald-400 mt-1">
                  Listening on {micDevice}
                </p>
              )}
              {config.captureMic && systemAudioDaemonConfig.enabled && micError && (
                <p className="text-xs text-destructive mt-1">{micError}</p>
              )}
              {config.captureMic && !systemAudioDaemonConfig.enabled && (
                <p className="text-xs text-muted-foreground mt-1">
                  Starts together with Meeting mode.
                </p>
              )}
            </div>
          </div>
          <Switch checked={config.captureMic} onCheckedChange={toggleMic} />
        </div>
      )}

      {config.engine === "local" && (
        <div className="space-y-3 rounded-lg border border-input/50 p-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Whisper model</p>
              <p className="text-xs text-muted-foreground">
                Bigger models are more accurate but slower. Base is a good start; try Tiny if
                transcription takes more than a few seconds on your machine.
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            {models.map((model) => {
              const p = progress[model.id];
              const active = config.localModel === model.id;
              const pct = p && p.total > 0 ? Math.round((p.downloaded / p.total) * 100) : null;
              return (
                <div
                  key={model.id}
                  className={cn(
                    "flex items-center gap-3 rounded-md border px-3 py-2",
                    active && model.downloaded ? "border-primary/50 bg-primary/5" : "border-input/40"
                  )}
                >
                  <button
                    type="button"
                    disabled={!model.downloaded}
                    onClick={() => setConfig({ localModel: model.id })}
                    className={cn(
                      "size-4 shrink-0 rounded-full border flex items-center justify-center",
                      model.downloaded ? "cursor-pointer" : "opacity-40 cursor-not-allowed",
                      active ? "border-primary" : "border-muted-foreground/50"
                    )}
                    aria-label={`Use ${model.name}`}
                  >
                    {active && <span className="size-2 rounded-full bg-primary" />}
                  </button>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{model.name}</span>
                      <span className="text-[10px] text-muted-foreground">{model.sizeMb} MB</span>
                      {model.id === "base.en" && (
                        <Badge variant="outline" className="text-[10px]">
                          Recommended
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground truncate">{model.description}</p>
                    {p && (
                      <div className="mt-1.5 flex items-center gap-2">
                        <div className="h-1.5 flex-1 rounded-full bg-muted overflow-hidden">
                          <div
                            className="h-full bg-primary transition-[width] duration-200"
                            style={{ width: `${pct ?? 0}%` }}
                          />
                        </div>
                        <span className="text-[10px] text-muted-foreground tabular-nums">
                          {pct !== null
                            ? `${formatMb(p.downloaded)} / ${formatMb(p.total)}`
                            : "Starting…"}
                        </span>
                      </div>
                    )}
                  </div>

                  {p || model.downloading ? (
                    <Button
                      size="icon"
                      variant="ghost"
                      title="Cancel download"
                      onClick={() => cancelDownload(model.id)}
                    >
                      <XIcon className="size-4" />
                    </Button>
                  ) : model.downloaded ? (
                    <Button
                      size="icon"
                      variant="ghost"
                      title="Delete model"
                      onClick={() => remove(model.id)}
                    >
                      <Trash2Icon className="size-4" />
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => download(model.id)}>
                      <DownloadIcon className="size-3.5" />
                      Download
                    </Button>
                  )}
                </div>
              );
            })}
          </div>

          {activeModel?.multilingual && (
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">Meeting language</p>
                <p className="text-xs text-muted-foreground">
                  Auto-detect works, but fixing the language is faster and more accurate.
                </p>
              </div>
              <Select value={config.language} onValueChange={(language) => setConfig({ language })}>
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LANGUAGES.map((l) => (
                    <SelectItem key={l.code} value={l.code}>
                      {l.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-2 border-t border-input/40 pt-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex gap-2">
                <RadioIcon className="size-4 mt-0.5 text-primary/80 shrink-0" />
                <div>
                  <p className="text-sm font-medium">Live transcription</p>
                  <p className="text-xs text-muted-foreground">
                    Transcribes in the background while Meeting mode is on, so the shortcut
                    responds instantly and can include several minutes of conversation. Uses
                    some CPU only while people are speaking.
                  </p>
                </div>
              </div>
              <Switch checked={config.live} onCheckedChange={(live) => setConfig({ live })} />
            </div>

            {config.live && (
              <div className="flex items-center justify-between gap-3 pl-6">
                <p className="text-xs text-muted-foreground">Send with each shortcut press</p>
                <Select
                  value={String(config.transcriptWindowSeconds)}
                  onValueChange={(v) => setConfig({ transcriptWindowSeconds: Number(v) })}
                >
                  <SelectTrigger className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TRANSCRIPT_WINDOWS.map((w) => (
                      <SelectItem key={w} value={String(w)}>
                        Last {windowLabel(w)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {config.live && speakerModel?.supported && (
              <div className="flex items-start justify-between gap-3 pl-6">
                <div>
                  <p className="text-xs font-medium">Tell speakers apart</p>
                  <p className="text-xs text-muted-foreground">
                    Labels different people as Speaker 1, Speaker 2… by their voice, so the AI
                    knows who asked what. Runs on this device; needs a {speakerModel.sizeMb} MB
                    voice model. Numbering starts fresh each time Meeting mode is turned on.
                  </p>
                  {progress[SPEAKER_MODEL_ID] && (
                    <p className="text-[10px] text-muted-foreground mt-1 tabular-nums">
                      Downloading voice model…{" "}
                      {progress[SPEAKER_MODEL_ID].total > 0 &&
                        `${Math.round(
                          (progress[SPEAKER_MODEL_ID].downloaded / progress[SPEAKER_MODEL_ID].total) * 100
                        )}%`}
                    </p>
                  )}
                </div>
                {speakerModel.downloaded ? (
                  <Switch
                    checked={config.separateSpeakers}
                    onCheckedChange={(separateSpeakers) => setConfig({ separateSpeakers })}
                  />
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={Boolean(progress[SPEAKER_MODEL_ID]) || speakerModel.downloading}
                    onClick={() => {
                      setProgress((prev) => ({
                        ...prev,
                        [SPEAKER_MODEL_ID]: {
                          id: SPEAKER_MODEL_ID,
                          downloaded: 0,
                          total: 0,
                          done: false,
                          error: null,
                        },
                      }));
                      invoke("speaker_model_download")
                        .then(() => setConfig({ separateSpeakers: true }))
                        .catch(() => {});
                    }}
                  >
                    <DownloadIcon className="size-3.5" />
                    Download
                  </Button>
                )}
              </div>
            )}

            {config.live && (
              <div id="auto-answer" className="space-y-2 pl-6">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-medium">Answer questions automatically</p>
                    <p className="text-xs text-muted-foreground">
                      When someone else in the meeting asks a question, Runningbord answers it
                      in the overlay without a shortcut press. Only their audio is used, and it
                      waits for them to finish speaking, and skips small talk, logistics (“can you
                      hear me?”, “is now a good time?”) and questions someone has already answered.
                      A question asked while an answer is still
                      being written is answered right after it. Each answer is a normal AI request.
                      While Meeting mode is on, the question-mark button in the overlay (or its
                      shortcut) turns this on and off.
                    </p>
                  </div>
                  <Switch
                    checked={config.autoAnswer}
                    onCheckedChange={(autoAnswer) => setConfig({ autoAnswer })}
                  />
                </div>
                {config.autoAnswer && (
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs text-muted-foreground">
                      Wait after they stop speaking. Longer waits keep long, multi-part
                      questions together; shorter ones answer sooner.
                    </p>
                    <Select
                      value={String(config.autoAnswerDelayMs)}
                      onValueChange={(v) => setConfig({ autoAnswerDelayMs: Number(v) })}
                    >
                      <SelectTrigger className="w-48 shrink-0">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {AUTO_ANSWER_DELAYS.map((ms) => (
                          <SelectItem key={ms} value={String(ms)}>
                            {ms / 1000} second{ms === 1000 ? "" : "s"}
                            {ms === 2000 ? " (default)" : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {config.autoAnswer && (
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-xs text-muted-foreground">
                      Include a screenshot (for questions about what's on screen)
                    </p>
                    <Switch
                      checked={config.autoAnswerScreenshot}
                      onCheckedChange={(autoAnswerScreenshot) => setConfig({ autoAnswerScreenshot })}
                    />
                  </div>
                )}
              </div>
            )}

            {liveWanted && (
              <div className="ml-6 rounded-md bg-muted/40 p-2 space-y-1">
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      liveStatus?.running ? "bg-emerald-500 animate-pulse" : "bg-muted-foreground/40"
                    )}
                  />
                  {liveStatus?.running
                    ? `Listening · ${liveStatus.segmentCount} lines buffered`
                    : "Not running"}
                  {!liveStatus?.running && activeModel?.downloaded && (
                    <button type="button" className="underline" onClick={startLive}>
                      Start
                    </button>
                  )}
                </div>
                {liveStatus?.lastError && (
                  <p className="text-[10px] text-destructive">{liveStatus.lastError}</p>
                )}
                {liveLines.length === 0 && !partials.system && !partials.mic ? (
                  <p className="text-xs text-muted-foreground italic">
                    Lines appear here as people speak.
                  </p>
                ) : (
                  <>
                    {liveLines.map((line, i) => (
                      <p key={`${line.startMs}-${i}`} className="text-xs">
                        <span className="font-medium text-muted-foreground">
                          {line.source === "mic"
                            ? "You"
                            : speakerDisplayName(line.speaker ?? "Them", speakerNames)}
                          :
                        </span>{" "}
                        {line.text}
                      </p>
                    ))}
                    {(["system", "mic"] as const).map(
                      (source) =>
                        partials[source] && (
                          <p key={source} className="text-xs text-muted-foreground italic">
                            <span className="font-medium">
                              {source === "mic" ? "You" : "Them"}:
                            </span>{" "}
                            {partials[source]}…
                          </p>
                        )
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          {!activeModel?.downloaded && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              The selected model isn't downloaded yet. Until it is, raw audio is sent instead.
            </p>
          )}
          {modelError && <p className="text-xs text-destructive">{modelError}</p>}
        </div>
      )}

      {config.engine === "cloud" && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-input/50 p-3">
          <div>
            <p className="text-sm font-medium">
              {cloudProvider ? `Using ${cloudProvider.id}` : "No provider selected"}
            </p>
            <p className="text-xs text-muted-foreground">
              Audio is sent only when you press the screenshot shortcut, never continuously. Your
              provider bills per minute of audio.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={() => navigate("/dev-space")}>
            {cloudProvider ? "Change" : "Set up"}
          </Button>
        </div>
      )}

      <div className="rounded-lg border border-dashed border-input/60 p-3 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">Test it</p>
            <p className="text-xs text-muted-foreground">
              {systemAudioDaemonConfig.enabled
                ? `Play some audio, then get the transcript of the last ${
                    config.engine === "local" && config.live
                      ? windowLabel(config.transcriptWindowSeconds)
                      : `${systemAudioDaemonConfig.bufferSeconds} seconds`
                  } exactly as the shortcut would.`
                : "Turn on Meeting mode above to test."}
            </p>
          </div>
          <Button
            size="sm"
            onClick={runTest}
            disabled={testing || !systemAudioDaemonConfig.enabled}
          >
            {testing ? <Loader2Icon className="size-3.5 animate-spin" /> : <PlayIcon className="size-3.5" />}
            Transcribe now
          </Button>
        </div>
        {systemAudioDaemonConfig.enabled && systemAudioError && (
          <p className="text-xs text-destructive">
            Meeting mode couldn't start: {systemAudioError}
          </p>
        )}
        {testResult && (
          <div className="space-y-1.5">
            {testResult.warning && (
              <p className="text-xs text-amber-700 dark:text-amber-400">{testResult.warning}</p>
            )}
            {testResult.transcript ? (
              <pre className="text-xs whitespace-pre-wrap rounded bg-muted/50 p-2 max-h-48 overflow-auto">
                {testResult.transcript}
              </pre>
            ) : (
              !testResult.warning && (
                <p className="text-xs text-muted-foreground">
                  {testResult.audioBase64 ? "Raw audio captured (no transcript in this mode)." : "No speech detected."}
                </p>
              )
            )}
            <p className="text-[10px] text-muted-foreground">
              Engine: {testResult.engineUsed} · {Math.round(testResult.fetchMs)} ms
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
