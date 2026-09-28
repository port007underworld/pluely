import { ScreenshotConfigs, TranscriptionSettings } from "./components";
import { useSettings } from "@/hooks";
import { PageLayout } from "@/layouts";

const Settings = () => {
  const settings = useSettings();
  return (
    <PageLayout
      title="Screenshot & Audio"
      description="Manage screenshot capture, meeting audio and transcription"
    >
      {/* Screenshot Configs */}
      <ScreenshotConfigs {...settings} />

      <TranscriptionSettings />
    </PageLayout>
  );
};

export default Settings;
