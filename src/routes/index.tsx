import { BrowserRouter as Router, Routes, Route, Navigate } from "react-router-dom";
import {
  App,
  SystemPrompts,
  ViewChat,
  Settings,
  DevSpace,
  Shortcuts,
  Screenshot,
  Chats,
  Responses,
  MyContext,
  Meeting,
  Welcome,
  Profiles,
} from "@/pages";
import { DashboardLayout } from "@/layouts";

export default function AppRoutes() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/welcome" element={<Welcome />} />
        <Route element={<DashboardLayout />}>
          <Route path="/dashboard" element={<Navigate to="/dev-space" replace />} />
          <Route path="/chats" element={<Chats />} />
          <Route path="/system-prompts" element={<SystemPrompts />} />
          <Route path="/context" element={<MyContext />} />
          <Route path="/profiles" element={<Profiles />} />
          <Route path="/chats/view/:conversationId" element={<ViewChat />} />
          <Route path="/shortcuts" element={<Shortcuts />} />
          <Route path="/screenshot" element={<Screenshot />} />
          <Route path="/meeting" element={<Meeting />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/responses" element={<Responses />} />
          <Route path="/dev-space" element={<DevSpace />} />
        </Route>
      </Routes>
    </Router>
  );
}
