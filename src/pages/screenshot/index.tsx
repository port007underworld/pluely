import { ScreenshotConfigs } from "./components";
import { useSettings } from "@/hooks";
import { PageLayout } from "@/layouts";
import { shortcutLabel } from "@/lib";

const Screenshot = () => {
  const settings = useSettings();
  const key = shortcutLabel("screenshot");
  return (
    <PageLayout
      title="Screenshot"
      description={`Press ${key || "the screenshot shortcut"} (or the camera button in the overlay) to show the AI what's on your screen. With Meeting mode on, it also gets what was just said.`}
    >
      <ScreenshotConfigs {...settings} />
    </PageLayout>
  );
};

export default Screenshot;
