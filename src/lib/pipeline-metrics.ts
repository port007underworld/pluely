import { ANALYTICS_EVENTS, captureEvent } from "./analytics";

export type ScreenshotTriggerSource = "fullscreen" | "selection";

export interface ShortcutPipelineMetrics {
  requestId: string;
  triggerSource: ScreenshotTriggerSource;
  customPromptUsed: boolean;
  screenshotCaptureMs?: number;
  audioFetchMs?: number;
  timeToFirstChunkMs?: number;
  requestRoundTripMs: number;
  totalPipelineMs: number;
  imagePayloadBytes: number;
  audioPayloadBytes: number;
  textPayloadBytes: number;
  totalPayloadBytes: number;
  hadAudio: boolean;
}

export function estimateBase64Bytes(base64: string): number {
  if (!base64) return 0;
  const sanitized = base64.trim();
  if (!sanitized) return 0;

  const padding = sanitized.endsWith("==")
    ? 2
    : sanitized.endsWith("=")
      ? 1
      : 0;

  return Math.max(0, Math.floor((sanitized.length * 3) / 4) - padding);
}

export function estimateUtf8Bytes(text: string): number {
  if (!text) return 0;
  return new TextEncoder().encode(text).length;
}

export async function emitShortcutPipelineMetrics(
  metrics: ShortcutPipelineMetrics
): Promise<void> {
  try {
    await captureEvent(ANALYTICS_EVENTS.MULTIMODAL_PIPELINE_METRICS, metrics);
  } catch {
    // Metrics are best-effort only.
  }

  console.info("[pipeline-metrics]", metrics);
}
