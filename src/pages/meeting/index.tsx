import { useNavigate } from "react-router-dom";
import { MeetingModeSettings, MeetingNotes, PinnedFacts, TranscriptionSettings } from "./components";
import { useSettings } from "@/hooks";
import { PageLayout } from "@/layouts";
import { shortcutLabel } from "@/lib";

const Meeting = () => {
  const settings = useSettings();
  const navigate = useNavigate();
  const screenshotKey = shortcutLabel("screenshot");
  const toggleKey = shortcutLabel("toggle_system_audio");

  return (
    <PageLayout
      title="Meeting"
      description={`With Meeting mode on, ${screenshotKey || "the screenshot shortcut"} also sends a transcript of what was just said, so the AI can answer the question you were asked. Turn it on here, with the waveform button in the overlay${toggleKey ? `, or ${toggleKey}` : ""}.`}
    >
      <MeetingModeSettings {...settings} />
      <PinnedFacts />
      <TranscriptionSettings />
      <MeetingNotes />
      <p className="text-xs text-muted-foreground">
        No audio coming through?{" "}
        <button
          type="button"
          className="underline underline-offset-2 hover:text-foreground cursor-pointer"
          onClick={() => navigate("/settings")}
        >
          Check permissions in Settings
        </button>
        .
      </p>
    </PageLayout>
  );
};

export default Meeting;
