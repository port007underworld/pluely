import { useNavigate } from "react-router-dom";
import { InfoIcon } from "lucide-react";
import { Header } from "@/components";
import { useTranscriptionConfig } from "@/lib";
import { UseSettingsReturn } from "@/types";
import { Providers } from "./Providers";
import { CustomProviders } from "./CustomProvider";

export const STTProviders = (settings: UseSettingsReturn) => {
  const navigate = useNavigate();
  const [transcription] = useTranscriptionConfig();
  const inUse = transcription.engine === "cloud";

  return (
    <div id="stt-providers" className="space-y-3">
      <Header
        title="STT Providers"
        description="Select your preferred STT service provider to get started."
        isMainTitle
      />

      <div className="flex items-start gap-2 rounded-lg border border-input/50 bg-muted/30 p-3">
        <InfoIcon className="size-4 mt-0.5 shrink-0 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">
          These settings are only used when Meeting Transcription is set to{" "}
          <strong>Cloud provider</strong>.{" "}
          {inUse
            ? "That's the current setting, so the provider selected here transcribes your meeting audio."
            : "It's currently set to a different option, so nothing here is used right now."}{" "}
          <button
            type="button"
            className="underline underline-offset-2 hover:text-foreground cursor-pointer"
            onClick={() => navigate("/screenshot")}
          >
            Change in Screenshot &amp; Audio
          </button>
        </p>
      </div>

      {/* Custom Provider */}
      <CustomProviders {...settings} />
      {/* Providers Selection */}
      <Providers {...settings} />
    </div>
  );
};
