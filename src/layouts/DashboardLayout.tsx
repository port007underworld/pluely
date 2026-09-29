import { Sidebar } from "@/components";
import { Navigate, Outlet } from "react-router-dom";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { needsOnboarding } from "@/lib";
import { ErrorBoundary } from "react-error-boundary";
import { ErrorLayout } from "./ErrorLayout";

export const DashboardLayout = () => {
  // Checked once per window load, so finishing or skipping setup sticks.
  const [onboarding] = useState(needsOnboarding);

  useEffect(() => {
    // The dashboard starts hidden; bring it up so new users see setup.
    if (onboarding) invoke("open_dashboard").catch(() => {});
  }, [onboarding]);

  if (onboarding) return <Navigate to="/welcome" replace />;

  return (
    <ErrorBoundary
      fallbackRender={() => {
        return <ErrorLayout />;
      }}
      resetKeys={["dashboard-error"]}
      onReset={() => {
        console.log("Reset");
      }}
    >
      <div className="relative flex h-screen w-screen overflow-hidden bg-background">
        {/* Draggable region */}
        <div
          className="absolute left-0 right-0 top-0 z-50 h-10 select-none"
          data-tauri-drag-region={true}
        />

        {/* Sidebar */}
        <Sidebar />
        {/* Main Content */}
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden px-8">
          <Outlet />
        </main>
      </div>
    </ErrorBoundary>
  );
};
