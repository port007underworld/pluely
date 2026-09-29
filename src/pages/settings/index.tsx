import {
  Theme,
  AlwaysOnTopToggle,
  AppIconToggle,
  Permissions,
  Updates,
  ChatHistory,
} from "./components";
import { PageLayout } from "@/layouts";

const Settings = () => {
  return (
    <PageLayout title="Settings" description="Manage your settings">
      {/* Theme */}
      <Theme />

      {/* App Icon Toggle */}
      <AppIconToggle />

      {/* Always On Top Toggle */}
      <AlwaysOnTopToggle />

      <Permissions />

      <ChatHistory />

      <Updates />
    </PageLayout>
  );
};

export default Settings;
