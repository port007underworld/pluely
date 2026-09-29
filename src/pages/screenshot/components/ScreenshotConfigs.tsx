import { useEffect, useState } from "react";
import {
  CheckCircle2Icon,
  ChevronRightIcon,
  MonitorIcon,
  PaperclipIcon,
  SendIcon,
  SquareDashedMousePointerIcon,
} from "lucide-react";
import { Header, Input, Label, Switch, Textarea } from "@/components";
import { DEFAULT_SCREENSHOT_AUTO_PROMPT } from "@/config";
import { cn } from "@/lib/utils";
import { UseSettingsReturn } from "@/types";

type Option<T extends string> = {
  value: T;
  title: string;
  description: string;
  icon: typeof MonitorIcon;
};

/** A row of selectable cards (single choice). */
function OptionCards<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="grid gap-2 @lg:grid-cols-2" role="radiogroup">
      {options.map((option) => {
        const selected = option.value === value;
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              "text-left rounded-lg border p-3 transition-colors cursor-pointer",
              selected
                ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                : "border-input/50 hover:bg-muted/40"
            )}
          >
            <div className="flex items-center justify-between gap-2 mb-1">
              <div className="flex items-center gap-2">
                <Icon className="size-4 text-primary/80" />
                <span className="text-sm font-medium">{option.title}</span>
              </div>
              {selected && <CheckCircle2Icon className="size-4 text-primary" />}
            </div>
            <p className="text-xs text-muted-foreground leading-snug">{option.description}</p>
          </button>
        );
      })}
    </div>
  );
}

export const ScreenshotConfigs = ({
  screenshotConfiguration,
  handleScreenshotModeChange,
  handleScreenshotPromptChange,
  handleScreenshotEnabledChange,
  handleScreenshotCompressionEnabledChange,
  handleScreenshotCompressionQualityChange,
  handleScreenshotCompressionMaxDimChange,
  handleScreenshotRecompressAttachmentsChange,
}: UseSettingsReturn) => {
  // Local drafts so number fields can be typed freely and validated on blur.
  const [qualityInput, setQualityInput] = useState(
    String(screenshotConfiguration.compressionQuality ?? 75)
  );
  const [maxDimInput, setMaxDimInput] = useState(
    String(screenshotConfiguration.compressionMaxDimension ?? 1600)
  );
  useEffect(() => {
    setQualityInput(String(screenshotConfiguration.compressionQuality ?? 75));
  }, [screenshotConfiguration.compressionQuality]);
  useEffect(() => {
    setMaxDimInput(String(screenshotConfiguration.compressionMaxDimension ?? 1600));
  }, [screenshotConfiguration.compressionMaxDimension]);

  const askRightAway = screenshotConfiguration.mode === "auto";

  return (
    <div id="screenshot" className="space-y-6">
      <div className="space-y-2">
        <Header
          title="What to capture"
          description="What the screenshot shortcut and the camera button capture."
        />
        <OptionCards
          value={screenshotConfiguration.enabled ? "full" : "area"}
          onChange={(v) => handleScreenshotEnabledChange(v === "full")}
          options={[
            {
              value: "full",
              title: "Full screen",
              description: "Captures the whole screen instantly.",
              icon: MonitorIcon,
            },
            {
              value: "area",
              title: "Let me select an area",
              description: "Drag to pick the part of the screen that matters (e.g. just the problem).",
              icon: SquareDashedMousePointerIcon,
            },
          ]}
        />
      </div>

      <div className="space-y-2">
        <Header title="After capturing" description="What happens with the screenshot." />
        <OptionCards
          value={screenshotConfiguration.mode}
          onChange={handleScreenshotModeChange}
          options={[
            {
              value: "auto",
              title: "Ask the AI right away",
              description:
                "Sends it immediately with the instructions below, plus what was just said if Meeting mode is on.",
              icon: SendIcon,
            },
            {
              value: "manual",
              title: "Attach it so I can type a question",
              description:
                "Adds it to your message instead. You can capture several before sending.",
              icon: PaperclipIcon,
            },
          ]}
        />
      </div>

      {askRightAway && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-sm font-medium">Instructions sent with each screenshot</Label>
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
            placeholder="What should the AI do with each screenshot?"
            value={screenshotConfiguration.autoPrompt}
            onChange={(e) => handleScreenshotPromptChange(e.target.value)}
            className="w-full min-h-40 text-sm border-1 border-input/50 focus:border-primary/50 transition-colors"
          />
          <p className="text-xs text-muted-foreground">
            Your system prompt (System Prompts page) sets the overall behavior and answer format;
            this says what to do with each capture.
          </p>
        </div>
      )}

      {/* Rarely needed, so collapsed by default. */}
      <details className="group rounded-lg border border-input/50 p-3">
        <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium select-none">
          <ChevronRightIcon className="size-4 transition-transform group-open:rotate-90" />
          Image quality (advanced)
        </summary>
        <div className="mt-3 space-y-3">
          <div className="flex justify-between items-center gap-3">
            <Header
              title="Compress screenshots"
              description="Resize and encode screenshots as JPEG. Uploads are faster and text stays legible."
            />
            <Switch
              checked={!!screenshotConfiguration.compressionEnabled}
              onCheckedChange={(checked) => handleScreenshotCompressionEnabledChange(checked as boolean)}
            />
          </div>

          {screenshotConfiguration.compressionEnabled && (
            <>
              <div className="grid @lg:grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-sm font-medium">JPEG quality (1–100)</Label>
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
                    Lower values give smaller images but less clarity.
                  </p>
                </div>
                <div className="space-y-1">
                  <Label className="text-sm font-medium">Max dimension (px)</Label>
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
                    Longest side before resizing.
                  </p>
                </div>
              </div>

              <div className="flex justify-between items-center gap-3">
                <Header
                  title="Also compress images I attach"
                  description="Apply the same settings to images you attach yourself."
                />
                <Switch
                  checked={!!screenshotConfiguration.recompressAttachments}
                  onCheckedChange={(checked) =>
                    handleScreenshotRecompressAttachmentsChange(checked as boolean)
                  }
                />
              </div>
            </>
          )}
        </div>
      </details>
    </div>
  );
};
