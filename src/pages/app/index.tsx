import { Card, DragButton, CustomCursor, Button } from "@/components";
import { Completion } from "./components";
import { useApp } from "@/hooks";
import { useApp as useAppContext } from "@/contexts";
import { SettingsIcon } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { ErrorBoundary } from "react-error-boundary";
import { ErrorLayout } from "@/layouts";
import { getPlatform, shortcutLabel, useUpdater } from "@/lib";

const App = () => {
  const { isHidden } = useApp();
  const { customizable } = useAppContext();
  const platform = getPlatform();

  const dashboardKey = shortcutLabel("toggle_dashboard");
  const update = useUpdater();
  const updateReady = update.status === "available";

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
              className="relative cursor-pointer"
              title={
                updateReady
                  ? `Update ${update.version} available: open Settings to install`
                  : dashboardKey
                  ? `Settings (${dashboardKey})`
                  : "Settings"
              }
              onClick={openDashboard}
            >
              <SettingsIcon className="h-4 w-4" />
              {updateReady && (
                <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-sky-500 ring-2 ring-background" />
              )}
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
