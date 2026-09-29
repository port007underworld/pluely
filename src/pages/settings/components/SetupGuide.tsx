import { useNavigate } from "react-router-dom";
import { SparklesIcon } from "lucide-react";
import { Button, Header } from "@/components";

export const SetupGuide = () => {
  const navigate = useNavigate();
  return (
    <div id="setup-guide" className="space-y-3">
      <Header
        title="Setup Guide"
        description="Walk through choosing an AI provider, granting permissions and downloading a transcription model again."
        isMainTitle
      />
      <Button variant="outline" onClick={() => navigate("/welcome")}>
        <SparklesIcon className="size-4" /> Run setup again
      </Button>
    </div>
  );
};
