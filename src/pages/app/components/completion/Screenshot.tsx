import { Button } from "@/components";
import { CameraIcon, Loader2 } from "lucide-react";
import { UseCompletionReturn } from "@/types";
import { MAX_FILES } from "@/config";
import { useApp } from "@/contexts";

export const Screenshot = ({
  screenshotConfiguration,
  attachedFiles,
  isLoading,
  captureScreenshot,
  isScreenshotLoading,
}: UseCompletionReturn) => {
  const { supportsImages } = useApp();
  const captureMode = screenshotConfiguration.enabled
    ? "full screen"
    : "select an area";
  const processingMode =
    screenshotConfiguration.mode === "auto" ? "sent to the AI right away" : "added to attachments";

  const isDisabled =
    attachedFiles.length >= MAX_FILES ||
    isLoading ||
    isScreenshotLoading ||
    !supportsImages;

  return (
    <Button
      size="icon"
      className="cursor-pointer"
      title={
        !supportsImages
          ? "Screenshot not supported by current AI provider"
          : `Screenshot (${captureMode}, ${processingMode})`
      }
      onClick={captureScreenshot}
      disabled={isDisabled}
    >
      {isScreenshotLoading ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <CameraIcon className="h-4 w-4" />
      )}
    </Button>
  );
};
