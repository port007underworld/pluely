import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  MeetingModeSettings,
  MeetingNotes,
  MeetingPrepCard,
  People,
  PinnedFacts,
  TalkTime,
  TranscriptionSettings,
} from "./components";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components";
import { useSettings } from "@/hooks";
import { PageLayout } from "@/layouts";
import { safeLocalStorage, shortcutLabel, useTranscriptionConfig } from "@/lib";

const TABS = [
  { id: "before", label: "Before" },
  { id: "during", label: "During" },
  { id: "after", label: "After" },
  { id: "setup", label: "Setup" },
] as const;
type TabId = (typeof TABS)[number]["id"];
const TAB_KEY = "meeting_tab";
const isTab = (value: string | null | undefined): value is TabId =>
  TABS.some((t) => t.id === value);

const Meeting = () => {
  const settings = useSettings();
  const navigate = useNavigate();
  const screenshotKey = shortcutLabel("screenshot");
  const toggleKey = shortcutLabel("toggle_system_audio");
  const { hash } = useLocation();
  const [transcription] = useTranscriptionConfig();
  const liveAvailable = transcription.engine === "local" && transcription.live;
  // A link can open a tab (/meeting#during); otherwise the last one used.
  const [tab, setTab] = useState<TabId>(() => {
    const fromLink = hash.replace("#", "");
    if (isTab(fromLink)) return fromLink;
    const saved = safeLocalStorage.getItem(TAB_KEY);
    return isTab(saved) ? saved : "before";
  });
  const choose = (value: string) => {
    if (!isTab(value)) return;
    setTab(value);
    safeLocalStorage.setItem(TAB_KEY, value);
  };

  return (
    <PageLayout
      title="Meeting"
      description={`With Meeting mode on, ${screenshotKey || "the screenshot shortcut"} also sends a transcript of what was just said, so the AI can answer the question you were asked. Turn it on here, with the waveform button in the overlay${toggleKey ? `, or ${toggleKey}` : ""}.`}
    >
      <Tabs value={tab} onValueChange={choose} className="gap-6">
        <TabsList>
          {TABS.map((t) => (
            <TabsTrigger key={t.id} value={t.id}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="before" className="space-y-8">
          <MeetingPrepCard />
          <PinnedFacts />
        </TabsContent>
        <TabsContent value="during" className="space-y-8">
          {!liveAvailable && (
            <p className="text-sm text-muted-foreground">
              People and talk time come from live, on-device transcription. Turn it on in{" "}
              <button
                type="button"
                className="underline underline-offset-2 hover:text-foreground cursor-pointer"
                onClick={() => choose("setup")}
              >
                Setup
              </button>
              .
            </p>
          )}
          <People />
          <TalkTime />
        </TabsContent>
        <TabsContent value="after" className="space-y-8">
          <MeetingNotes />
        </TabsContent>
        <TabsContent value="setup" className="space-y-8">
          <MeetingModeSettings {...settings} />
          <TranscriptionSettings />
        </TabsContent>
      </Tabs>
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
