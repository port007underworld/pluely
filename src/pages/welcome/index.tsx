import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeftIcon, ArrowRightIcon, CheckIcon } from "lucide-react";
import { Button } from "@/components";
import { useSettings } from "@/hooks";
import { completeOnboarding, getPlatform } from "@/lib";
import { cn } from "@/lib/utils";
import { AIProviders } from "../dev/components";
import { Permissions } from "../settings/components";
import { WhisperSetup } from "./WhisperSetup";

type Step = "provider" | "permissions" | "transcription";

const STEP_LABELS: Record<Step, string> = {
  provider: "AI provider",
  permissions: "Permissions",
  transcription: "Transcription",
};

const Welcome = () => {
  const navigate = useNavigate();
  const settings = useSettings();
  const steps: Step[] =
    getPlatform() === "macos"
      ? ["provider", "permissions", "transcription"]
      : ["provider", "transcription"];
  const [index, setIndex] = useState(0);
  const step = steps[index];
  const isLast = index === steps.length - 1;

  const { selectedAIProvider, variables } = settings;
  const providerReady =
    !!selectedAIProvider.provider &&
    variables.every(
      ({ key }) => key === "slow_model" || !!selectedAIProvider.variables?.[key]?.trim()
    );

  const finish = () => {
    completeOnboarding();
    navigate("/chats", { replace: true });
  };

  return (
    <div className="relative flex h-screen w-screen flex-col overflow-hidden bg-background">
      <div className="absolute left-0 right-0 top-0 z-50 h-10 select-none" data-tauri-drag-region />

      <header className="flex items-center justify-between px-8 pt-12 pb-4">
        <div>
          <h1 className="text-xl font-semibold">Welcome to Runningbord</h1>
          <p className="text-sm text-muted-foreground">
            A few things to set up before your first meeting. Everything here can be changed later.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={finish}>
          Skip setup
        </Button>
      </header>

      <ol className="flex gap-2 px-8 pb-4">
        {steps.map((s, i) => (
          <li
            key={s}
            className={cn(
              "flex flex-1 items-center gap-2 border-t-2 pt-2 text-xs",
              i <= index ? "border-primary text-foreground" : "border-muted text-muted-foreground"
            )}
          >
            <span
              className={cn(
                "flex size-5 items-center justify-center rounded-full border text-[10px]",
                i < index && "bg-primary text-primary-foreground border-primary"
              )}
            >
              {i < index ? <CheckIcon className="size-3" /> : i + 1}
            </span>
            {STEP_LABELS[s]}
          </li>
        ))}
      </ol>

      <main className="flex-1 overflow-y-auto px-8 pb-6">
        {step === "provider" && <AIProviders {...settings} />}
        {step === "permissions" && <Permissions />}
        {step === "transcription" && <WhisperSetup />}
      </main>

      <footer className="flex items-center justify-between gap-4 border-t px-8 py-4">
        <Button variant="outline" onClick={() => setIndex(index - 1)} disabled={index === 0}>
          <ArrowLeftIcon className="size-4" /> Back
        </Button>
        <div className="flex items-center gap-3">
          {step === "provider" && !providerReady && (
            <p className="text-xs text-muted-foreground">Pick a provider and fill in its fields.</p>
          )}
          {isLast ? (
            <Button onClick={finish}>
              Finish <CheckIcon className="size-4" />
            </Button>
          ) : (
            <Button
              onClick={() => setIndex(index + 1)}
              variant={step === "provider" && !providerReady ? "outline" : "default"}
            >
              {step === "provider" && !providerReady ? "Skip for now" : "Next"}
              <ArrowRightIcon className="size-4" />
            </Button>
          )}
        </div>
      </footer>
    </div>
  );
};

export default Welcome;
