import { getPlatform } from "./platform";
import { getShortcutsConfig } from "./storage/shortcuts.storage";

/** "cmd+shift+d" -> "⌘⇧D" on macOS, "Ctrl+Shift+D" elsewhere. */
export function formatShortcut(key: string): string {
  if (!key) return "";
  const mac = getPlatform() === "macos";
  const names: Record<string, string> = mac
    ? { cmd: "⌘", command: "⌘", shift: "⇧", alt: "⌥", option: "⌥", ctrl: "⌃", control: "⌃" }
    : { ctrl: "Ctrl+", control: "Ctrl+", shift: "Shift+", alt: "Alt+", cmd: "Ctrl+" };
  return key
    .split("+")
    .map((part) => names[part.toLowerCase()] ?? part.toUpperCase())
    .join("");
}

/** The user's current key for a shortcut action, formatted; "" if unset. */
export function shortcutLabel(actionId: string): string {
  const binding = getShortcutsConfig().bindings[actionId];
  return binding?.enabled === false ? "" : formatShortcut(binding?.key ?? "");
}
