import { TYPE_PROVIDER } from "./provider.type";
import { ScreenshotConfig, ScreenshotMode, SystemAudioDaemonConfig } from "./settings";

export interface UseSettingsReturn {
  screenshotConfiguration: ScreenshotConfig;
  setScreenshotConfiguration: React.Dispatch<
    React.SetStateAction<ScreenshotConfig>
  >;
  systemAudioDaemonConfig: SystemAudioDaemonConfig;
  setSystemAudioDaemonConfig: React.Dispatch<
    React.SetStateAction<SystemAudioDaemonConfig>
  >;
  handleSystemAudioDaemonEnabledChange: (enabled: boolean) => void;
  handleSystemAudioDaemonBufferSecondsChange: (bufferSeconds: number) => void;
  handleScreenshotModeChange: (value: ScreenshotMode) => void;
  handleScreenshotPromptChange: (value: string) => void;
  handleScreenshotEnabledChange: (enabled: boolean) => void;
  handleScreenshotCompressionEnabledChange: (enabled: boolean) => void;
  handleScreenshotCompressionQualityChange: (quality: number) => void;
  handleScreenshotCompressionMaxDimChange: (maxDim: number) => void;
  handleScreenshotRecompressAttachmentsChange: (enabled: boolean) => void;
  allAiProviders: TYPE_PROVIDER[];
  allSttProviders: TYPE_PROVIDER[];
  selectedAIProvider: { provider: string; variables: Record<string, string> };
  selectedSttProvider: {
    provider: string;
    variables: Record<string, string>;
  };
  onSetSelectedAIProvider: (provider: {
    provider: string;
    variables: Record<string, string>;
  }) => void;
  onSetSelectedSttProvider: (provider: {
    provider: string;
    variables: Record<string, string>;
  }) => void;
  variables: { key: string; value: string }[];
  sttVariables: { key: string; value: string }[];
}
