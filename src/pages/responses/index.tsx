import {
  ResponseLength,
  LanguageSelector,
  AutoScrollToggle,
  ConversationMemory,
} from "./components";
import { PageLayout } from "@/layouts";

const Responses = () => {
  return (
    <PageLayout
      title="Response Settings"
      description="Customize how AI generates and displays responses"
    >

      {/* Response Length */}
      <ResponseLength />

      {/* Language Selector */}
      <LanguageSelector />

      {/* Auto-Scroll Toggle */}
      <AutoScrollToggle />

      <ConversationMemory />
    </PageLayout>
  );
};

export default Responses;
