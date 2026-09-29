import { Card, DragButton, CustomCursor, Button } from "@/components";
import { Completion } from "./components";
import { useApp } from "@/hooks";
import { useApp as useAppContext } from "@/contexts";
import { SettingsIcon } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { ErrorBoundary } from "react-error-boundary";
import { ErrorLayout } from "@/layouts";
import { getPlatform, getShortcutsConfig } from "@/lib";

/** "cmd+shift+d" -> "⌘⇧D" on macOS, "Ctrl+Shift+D" elsewhere. */
function formatShortcut(key: string): string {
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

const App = () => {
  const { isHidden } = useApp();
  const { customizable } = useAppContext();
  const platform = getPlatform();

  const dashboardKey = formatShortcut(
    getShortcutsConfig().bindings.toggle_dashboard?.key ?? ""
  );

  const openDashboard = async () => {
    try {
      await invoke("open_dashboard");
    } catch (error) {
      console.error("Failed to open dashboard:", error);
    }
  };

  return (
    <ErrorBoundary
      fallbackRender={() => {
        return <ErrorLayout isCompact />;
      }}
      resetKeys={["app-error"]}
      onReset={() => {
        console.log("Reset");
      }}
    >
      <div
        className={`w-screen h-screen flex overflow-hidden justify-center items-start ${
          isHidden ? "hidden pointer-events-none" : ""
        }`}
      >
        <Card className="w-full flex flex-row items-center gap-2 p-2">
          <div className="w-full flex flex-row gap-2 items-center">
            <Completion isHidden={isHidden} />
            <Button
              size={"icon"}
              className="cursor-pointer"
              title={dashboardKey ? `Settings (${dashboardKey})` : "Settings"}
              onClick={openDashboard}
            >
              <SettingsIcon className="h-4 w-4" />
            </Button>
          </div>
          <DragButton />
        </Card>
        {customizable.cursor.type === "invisible" && platform !== "linux" ? (
          <CustomCursor />
        ) : null}
      </div>
    </ErrorBoundary>
  );
};

export default App;
