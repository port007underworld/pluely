import { invoke } from "@tauri-apps/api/core";
import { MAX_FILES } from "@/config";
import { AttachedFile, ScreenshotConfig, TYPE_PROVIDER } from "@/types";

const readAsBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

/** Read a picked or pasted file, recompressing images if the user asked for it. */
export async function fileToAttachment(
  file: File,
  screenshotConfig?: ScreenshotConfig
): Promise<AttachedFile> {
  let base64: string;
  let type = file.type;
  let name = file.name;

  const recompress =
    screenshotConfig?.recompressAttachments &&
    screenshotConfig?.compressionEnabled &&
    file.type.startsWith("image/");

  if (recompress) {
    try {
      const { compressImageFile } = await import("@/lib/utils");
      base64 = await compressImageFile(
        file,
        screenshotConfig.compressionMaxDimension ?? 1600,
        screenshotConfig.compressionQuality ?? 75
      );
      type = "image/jpeg";
      name = name.replace(/\.[^/.]+$/, "") + ".jpg";
    } catch (e) {
      console.warn("Recompression failed, attaching the original file:", e);
      base64 = await readAsBase64(file);
    }
  } else {
    base64 = await readAsBase64(file);
  }

  return { id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, name, type, base64, size: base64.length };
}

/** Images and audio from a file picker, limited to the remaining attachment slots. */
export function attachableFiles(files: File[], alreadyAttached: number): File[] {
  return files
    .filter((f) => f.type.startsWith("image/") || f.type.startsWith("audio/"))
    .slice(0, Math.max(0, MAX_FILES - alreadyAttached));
}

/**
 * Images from a paste event, limited to the remaining slots. Returns null when
 * the clipboard has no images (so normal text paste proceeds); otherwise it
 * prevents the default paste.
 */
export function pastedImages(e: React.ClipboardEvent, alreadyAttached: number): File[] | null {
  const items = Array.from(e.clipboardData?.items ?? []);
  const images = items.filter((item) => item.type.startsWith("image/"));
  if (images.length === 0) return null;
  e.preventDefault();
  return images
    .map((item) => item.getAsFile())
    .filter((f): f is File => f !== null)
    .slice(0, Math.max(0, MAX_FILES - alreadyAttached));
}

/** Full-screen capture with the user's compression settings, as base64. */
export function captureFullScreen(config: ScreenshotConfig): Promise<string> {
  return invoke<string>("capture_to_base64", {
    compressionEnabled: config.compressionEnabled ?? true,
    compressionQuality: config.compressionQuality ?? 75,
    compressionMaxDimension: config.compressionMaxDimension ?? 1600,
  });
}

/** The configured AI provider, or a user-facing reason it can't be used. */
export function resolveAIProvider(
  selected: { provider: string },
  all: TYPE_PROVIDER[]
): { provider: TYPE_PROVIDER } | { error: string } {
  if (!selected.provider) return { error: "Please select an AI provider in settings" };
  const provider = all.find((p) => p.id === selected.provider);
  return provider ? { provider } : { error: "Invalid provider selected" };
}
