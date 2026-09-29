import {
  Label,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  Header,
  Switch,
  Textarea,
} from "@/components";
import { DEFAULT_SCREENSHOT_AUTO_PROMPT } from "@/config";
import { UseSettingsReturn } from "@/types";
import { useTranscriptionConfig } from "@/lib";
import { useState, useEffect } from "react";
import { LaptopMinimalIcon, MousePointer2Icon } from "lucide-react";

export const ScreenshotConfigs = ({
  screenshotConfiguration,
  handleScreenshotModeChange,
  handleScreenshotPromptChange,
  handleScreenshotEnabledChange,
  handleScreenshotCompressionEnabledChange,
  handleScreenshotCompressionQualityChange,
  handleScreenshotCompressionMaxDimChange,
  handleScreenshotRecompressAttachmentsChange,
  systemAudioDaemonConfig,
  handleSystemAudioDaemonEnabledChange,
  handleSystemAudioDaemonBufferSecondsChange,
  hasActiveLicense,
}: UseSettingsReturn) => {

    const [transcriptionConfig] = useTranscriptionConfig();
  const liveTranscription =
    transcriptionConfig.engine === "local" && transcriptionConfig.live;

  // ---- local draft input state (smooth typing) ----
  const [bufferInput, setBufferInput] = useState(
    String(systemAudioDaemonConfig.bufferSeconds ?? 30)
  );
  const [qualityInput, setQualityInput] = useState(
    String(screenshotConfiguration.compressionQuality ?? 75)
  );
  const [maxDimInput, setMaxDimInput] = useState(
    String(screenshotConfiguration.compressionMaxDimension ?? 1600)
  );

  // ---- sync drafts when external config changes ----
  useEffect(() => {
    setBufferInput(String(systemAudioDaemonConfig.bufferSeconds ?? 30));
  }, [systemAudioDaemonConfig.bufferSeconds]);

  useEffect(() => {
    setQualityInput(String(screenshotConfiguration.compressionQuality ?? 75));
  }, [screenshotConfiguration.compressionQuality]);

  useEffect(() => {
    setMaxDimInput(
      String(screenshotConfiguration.compressionMaxDimension ?? 1600)
    );
  }, [screenshotConfiguration.compressionMaxDimension]);


  return (
    <div id="screenshot" className="space-y-3">
      <div className="space-y-3">
        {/* Screenshot Capture Mode: Selection and Screenshot */}
        <div className="space-y-2">
          <div className="flex flex-col">
            <Header
              title="Capture Method"
              description={
                screenshotConfiguration.enabled
                  ? "Screenshot Mode: Quickly capture the entire screen with one click."
                  : "Selection Mode: Click and drag to select a specific area to capture."
              }
            />
          </div>
          <Select
            value={screenshotConfiguration.enabled ? "screenshot" : "selection"}
            onValueChange={(value) =>
              handleScreenshotEnabledChange(value === "screenshot")
            }
          >
            <SelectTrigger className="w-full h-11 border-1 border-input/50 focus:border-primary/50 transition-colors">
              <div className="flex items-center gap-2">
                {screenshotConfiguration.enabled ? (
                  <LaptopMinimalIcon className="size-4" />
                ) : (
                  <MousePointer2Icon className="size-4" />
                )}
                <div className="text-sm font-medium">
                  {screenshotConfiguration.enabled
                    ? "Screenshot Mode"
                    : "Selection Mode"}
                </div>
              </div>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="selection" disabled={!hasActiveLicense}>
                <div className="flex items-center gap-2">
                  <MousePointer2Icon className="size-4" />
                  <div className="font-medium">Selection Mode</div>
                  {!hasActiveLicense && (
                    <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded">
                      You need an active license to use Selection Mode.
                    </span>
                  )}
                </div>
              </SelectItem>
              <SelectItem value="screenshot" className="flex flex-row gap-2">
                <LaptopMinimalIcon className="size-4" />
                <div className="font-medium">Screenshot Mode</div>
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Mode Selection: Auto and Manual */}
        <div className="space-y-2">
          <div className="flex flex-col">
            <Header
              title="Processing Mode"
              description={
                screenshotConfiguration.mode === "manual"
                  ? "Screenshots will be captured and automatically added to your attached files. You can then submit them with your own prompt. you can capture multiple screenshots and submit them later."
                  : "Screenshots will be automatically submitted to AI using your custom prompt. No manual intervention required. only one screenshot can be submitted at a time."
              }
            />
          </div>
          <Select
            value={screenshotConfiguration.mode}
            onValueChange={handleScreenshotModeChange}
          >
            <SelectTrigger className="w-full h-11 border-1 border-input/50 focus:border-primary/50 transition-colors">
              <div className="flex items-center gap-2">
                <div className="text-sm font-medium">
                  {screenshotConfiguration.mode === "auto" ? "Auto" : "Manual"}{" "}
                  Mode
                </div>
              </div>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="manual">
                <div className="font-medium">Manual Mode</div>
              </SelectItem>
              <SelectItem value="auto">
                <div className="font-medium">Auto Mode</div>
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Auto Prompt Input - Only show when auto mode is selected */}
        {screenshotConfiguration.mode === "auto" && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-medium">Auto Prompt</Label>
              {screenshotConfiguration.autoPrompt !== DEFAULT_SCREENSHOT_AUTO_PROMPT && (
                <button
                  type="button"
                  className="text-xs text-muted-foreground underline-offset-2 hover:underline hover:text-foreground"
                  onClick={() => handleScreenshotPromptChange(DEFAULT_SCREENSHOT_AUTO_PROMPT)}
                >
                  Reset to default
                </button>
              )}
            </div>
            <Textarea
              placeholder="Enter prompt for automatic screenshot analysis..."
              value={screenshotConfiguration.autoPrompt}
              onChange={(e) => handleScreenshotPromptChange(e.target.value)}
              className="w-full min-h-40 text-sm border-1 border-input/50 focus:border-primary/50 transition-colors"
            />
            <p className="text-xs text-muted-foreground">
              Sent with every screenshot shortcut, together with the meeting transcript. The system
              prompt (System Prompts page) sets the overall behavior; this one says what to do with
              each capture.
            </p>
          </div>
        )}


            {/* Compression settings - visible regardless of attach-on-every-request */}
            <div className="flex justify-between items-center space-x-2 pt-3">
              <div className="flex-1">
                <Header
                  title="Compress screenshots"
                  description="Reduce image size by resizing and encoding screenshots as JPEG. This speeds up uploads while keeping text legible. Can also recompress manually attached images if enabled."
                />
              </div>
              <div className="flex items-center">
                <Switch
                  checked={!!screenshotConfiguration.compressionEnabled}
                  onCheckedChange={(checked) =>
                    handleScreenshotCompressionEnabledChange(checked as boolean)
                  }
                />
              </div>
            </div>

            {/* Compression options */}
            {screenshotConfiguration.compressionEnabled && (
              <div className="grid sm:grid-cols-2 gap-2 mt-3">
                <div className="space-y-1">
                  <Label className="text-sm font-medium">JPEG Quality (1-100)</Label>
                  <Input
                    type="number"
                    min={20}
                    max={100}
                    value={qualityInput}
                    onChange={(e) => setQualityInput(e.target.value)}
                    onBlur={(e) => {
                      const v = parseInt(e.target.value, 10);
                      const finalValue = Number.isNaN(v) ? 75 : Math.min(100, Math.max(1, v));
                      setQualityInput(String(finalValue));
                      handleScreenshotCompressionQualityChange(finalValue);
                    }}
                    className="w-full h-11 border-1 border-input/50 focus:border-primary/50 transition-colors"
                  />
                  <p className="text-xs text-muted-foreground">
                    Lower values produce smaller images but reduce clarity.
                  </p>
                </div>

                <div className="space-y-1">
                  <Label className="text-sm font-medium">Max Dimension (px)</Label>
                  <Input
                    type="number"
                    min={400}
                    max={5000}
                    value={maxDimInput}
                    onChange={(e) => setMaxDimInput(e.target.value)}
                    onBlur={(e) => {
                      const v = parseInt(e.target.value, 10);
                      const finalValue = Number.isNaN(v) ? 1600 : Math.min(5000, Math.max(400, v));
                      setMaxDimInput(String(finalValue));
                      handleScreenshotCompressionMaxDimChange(finalValue);
                    }}
                    className="w-full h-11 border-1 border-input/50 focus:border-primary/50 transition-colors"
                  />
                  <p className="text-xs text-muted-foreground">
                    Maximum length of the longest side before resizing.
                  </p>
                </div>
              </div>
            )}

            {/* Optionally recompress manually attached images */}
            {screenshotConfiguration.compressionEnabled && (
              <div className="flex justify-between items-center space-x-2 pt-3">
                <div className="flex-1">
                  <Header
                    title="Recompress attachments"
                    description="When enabled, images you attach manually will be recompressed with the same compression settings."
                  />
                </div>
                <div className="flex items-center">
                  <Switch
                    checked={!!screenshotConfiguration.recompressAttachments}
                    onCheckedChange={(checked) =>
                      handleScreenshotRecompressAttachmentsChange(checked as boolean)
                    }
                  />
                </div>
              </div>
            )}

      </div>

      {/* Step 1 of meeting audio: capture. What happens to it is step 2 (TranscriptionSettings). */}
      <div id="system-audio" className="space-y-3 pt-4 border-t border-border/50">
        <Header
          title="1. Meeting mode"
          description="While Meeting mode is on, Runningbord listens to your computer's audio (the other people in a call), plus your microphone if you enable it below, and transcribes it so the screenshot shortcut can include what was just said. Nothing leaves your machine until you press the shortcut. Also toggled by the speaker icon in the overlay or its shortcut. Needs macOS 14.2+."
        />
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <Label className="text-sm font-medium">Meeting mode</Label>
            <Switch
              checked={systemAudioDaemonConfig.enabled}
              onCheckedChange={handleSystemAudioDaemonEnabledChange}
            />
          </div>
          {systemAudioDaemonConfig.enabled && liveTranscription && (
            <p className="text-xs text-muted-foreground">
              Live transcription is on, so how much conversation is sent is set under{" "}
              <em>Send with each shortcut press</em> below.
            </p>
          )}
          {systemAudioDaemonConfig.enabled && !liveTranscription && (
            <div className="flex items-center justify-between gap-2">
              <div>
                <Label className="text-sm">Audio sent per shortcut (seconds)</Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  The most recent seconds of audio that get transcribed or attached when you press
                  the shortcut (5–300).
                </p>
              </div>
            <input
              type="number"
              min={5}
              max={300}
              value={bufferInput}
              onChange={(e) => setBufferInput(e.target.value)}
              onBlur={(e) => {
                const v = parseInt(e.target.value, 10);
                const finalValue = Number.isNaN(v) ? 30 : Math.min(300, Math.max(5, v));
                setBufferInput(String(finalValue));
                handleSystemAudioDaemonBufferSecondsChange(finalValue);
              }}
              className="h-9 w-20 rounded-md border border-input bg-background px-2 text-sm"
            />

            </div>
          )}
        </div>
      </div>

      {/* Tips */}
      <div className="text-xs text-muted-foreground/70">
        <p>
          💡 <strong>Tip:</strong>{" "}
          {screenshotConfiguration.enabled
            ? "Screenshot mode captures the full screen with one click."
            : "Selection mode lets you choose specific areas to capture."}{" "}
          Auto mode is great for quick analysis, manual mode gives you more
          control.
        </p>
      </div>
    </div>
  );
};
