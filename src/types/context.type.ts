import { Dispatch, SetStateAction } from "react";
import { ScreenshotConfig, SystemAudioDaemonConfig, TYPE_PROVIDER } from "@/types";
import { CursorType, CustomizableState } from "@/lib/storage";

export type IContextType = {
  systemPrompt: string;
  setSystemPrompt: Dispatch<SetStateAction<string>>;
  allAiProviders: TYPE_PROVIDER[];
  customAiProviders: TYPE_PROVIDER[];
  selectedAIProvider: {
    provider: string;
    variables: Record<string, string>;
  };
  onSetSelectedAIProvider: ({
    provider,
    variables,
  }: {
    provider: string;
    variables: Record<string, string>;
  }) => void;
  allSttProviders: TYPE_PROVIDER[];
  customSttProviders: TYPE_PROVIDER[];
  selectedSttProvider: {
    provider: string;
    variables: Record<string, string>;
  };
  onSetSelectedSttProvider: ({
    provider,
    variables,
  }: {
    provider: string;
    variables: Record<string, string>;
  }) => void;
  screenshotConfiguration: ScreenshotConfig;
  setScreenshotConfiguration: React.Dispatch<
    React.SetStateAction<ScreenshotConfig>
  >;
  // Whether macOS Screen Recording permission has been granted
  screenRecordingPermissionGranted: boolean;
  setScreenRecordingPermission: (granted: boolean) => void;
  systemAudioDaemonConfig: SystemAudioDaemonConfig;
  setSystemAudioDaemonConfig: React.Dispatch<React.SetStateAction<SystemAudioDaemonConfig>>;
  customizable: CustomizableState;
  toggleAppIconVisibility: (isVisible: boolean) => Promise<void>;
  toggleAlwaysOnTop: (isEnabled: boolean) => Promise<void>;
  loadData: () => void;
  runningbordApiEnabled: boolean;
  setRunningbordApiEnabled: (enabled: boolean) => Promise<void>;
  hasActiveLicense: boolean;
  setHasActiveLicense: Dispatch<SetStateAction<boolean>>;
  getActiveLicenseStatus: () => Promise<void>;
  setCursorType: (type: CursorType) => void;
  supportsImages: boolean;
  setSupportsImages: (value: boolean) => void;
  modelSpeed: "fast" | "slow";
  setModelSpeed: (speed: "fast" | "slow") => void;
};
