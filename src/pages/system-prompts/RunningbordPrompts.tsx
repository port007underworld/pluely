import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  Header,
  Empty,
  GetLicense,
} from "@/components";
import {
  CheckCircle2,
  Sparkles,
  BotIcon,
  LockIcon,
  ClockIcon,
} from "lucide-react";
import { useApp } from "@/contexts";
import { clearSelectedPreset, safeLocalStorage } from "@/lib";
import { STORAGE_KEYS } from "@/config";
import moment from "moment";

interface RunningbordPrompt {
  title: string;
  prompt: string;
  modelId: string;
  modelName: string;
}

interface RunningbordPromptsResponse {
  prompts: RunningbordPrompt[];
  total: number;
  last_updated?: string;
}

interface Model {
  provider: string;
  name: string;
  id: string;
  model: string;
  description: string;
  modality: string;
  isAvailable: boolean;
}

const SELECTED_RUNNINGBORD_MODEL_STORAGE_KEY = "selected_runningbord_model";
const SELECTED_RUNNINGBORD_PROMPT_STORAGE_KEY = "selected_runningbord_prompt";

export const RunningbordPrompts = () => {
  const { setSystemPrompt, hasActiveLicense, setSupportsImages } = useApp();
  const [prompts, setPrompts] = useState<RunningbordPrompt[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [selectedRunningbordPrompt, setSelectedRunningbordPrompt] =
    useState<RunningbordPrompt | null>(() => {
      // Load selected prompt from local storage on initial render
      const stored = safeLocalStorage.getItem(
        SELECTED_RUNNINGBORD_PROMPT_STORAGE_KEY
      );
      if (stored) {
        try {
          return JSON.parse(stored);
        } catch {
          return null;
        }
      }
      return null;
    });
  const [models, setModels] = useState<Model[]>([]);
  const fetchInitiated = useRef(false);

  useEffect(() => {
    if (!fetchInitiated.current) {
      fetchInitiated.current = true;
      fetchRunningbordPrompts();
      fetchModels();
    }
  }, []);

  // Watch for changes in user's selected prompt and clear Runningbord selection if needed
  useEffect(() => {
    const checkUserPromptSelection = () => {
      const userSelectedPromptId = safeLocalStorage.getItem(
        STORAGE_KEYS.SELECTED_SYSTEM_PROMPT_ID
      );
      // If user has selected one of their own prompts, clear Runningbord prompt selection
      if (userSelectedPromptId) {
        setSelectedRunningbordPrompt(null);
      }
    };

    // Check on mount
    checkUserPromptSelection();

    // Listen for storage changes
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === STORAGE_KEYS.SELECTED_SYSTEM_PROMPT_ID) {
        checkUserPromptSelection();
      }
    };

    window.addEventListener("storage", handleStorageChange);
    return () => window.removeEventListener("storage", handleStorageChange);
  }, []);

  const fetchRunningbordPrompts = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await invoke<RunningbordPromptsResponse>("fetch_prompts");
      setPrompts(response.prompts);
      if (response.last_updated) {
        setLastUpdated(response.last_updated);
      }
    } catch (err) {
      console.error("Failed to fetch Runningbord prompts:", err);
      setError(
        typeof err === "string" ? err : "Failed to fetch Runningbord prompts"
      );
    } finally {
      setIsLoading(false);
    }
  };

  const fetchModels = async () => {
    try {
      const fetchedModels = await invoke<Model[]>("fetch_models");
      setModels(fetchedModels);
    } catch (error) {
      console.error("Failed to fetch models:", error);
    }
  };

  const handleSelectRunningbordPrompt = async (prompt: RunningbordPrompt) => {
    try {
      // Set the system prompt
      setSystemPrompt(prompt.prompt);
      setSelectedRunningbordPrompt(prompt);

      // Clear the user's selected prompt ID from local storage
      // This ensures the user prompt cards don't show as selected
      safeLocalStorage.removeItem(STORAGE_KEYS.SELECTED_SYSTEM_PROMPT_ID);
      clearSelectedPreset();

      // Save the system prompt to local storage
      safeLocalStorage.setItem(STORAGE_KEYS.SYSTEM_PROMPT, prompt.prompt);

      // Save the selected Runningbord prompt to local storage for persistence
      safeLocalStorage.setItem(
        SELECTED_RUNNINGBORD_PROMPT_STORAGE_KEY,
        JSON.stringify(prompt)
      );

      // Find the model by modelId and select it
      const matchingModel = models.find(
        (model) => model.model === prompt.modelId || model.id === prompt.modelId
      );

      if (matchingModel) {
        // Update supportsImages based on model modality
        const hasImageSupport = matchingModel.modality?.includes("image") ?? false;
        setSupportsImages(hasImageSupport);

        // Save model selection to local storage instead of secure storage
        safeLocalStorage.setItem(
          SELECTED_RUNNINGBORD_MODEL_STORAGE_KEY,
          JSON.stringify(matchingModel)
        );
      }
    } catch (error) {
      console.error("Failed to select Runningbord prompt:", error);
    }
  }; 

  const handleCardClick = (prompt: RunningbordPrompt) => {
    handleSelectRunningbordPrompt(prompt);
  };

  const isPromptSelected = (prompt: RunningbordPrompt) => {
    return (
      selectedRunningbordPrompt?.title === prompt.title &&
      selectedRunningbordPrompt?.modelId === prompt.modelId
    );
  };

  if (isLoading) {
    return (
      <div className="space-y-4 mt-6">
        <Header
          title="Runningbord Default Prompts"
          description="Pre-configured prompts with optimal model selection"
        />
        <Empty
          isLoading={true}
          icon={Sparkles}
          title="Loading prompts..."
          description="Fetching Runningbord default prompts"
        />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-4 mt-6">
        <Header
          title="Runningbord Default Prompts"
          description="Pre-configured prompts with optimal model selection"
        />
        <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-3">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      </div>
    );
  }

  if (prompts.length === 0) {
    return null;
  }

  return (
    <div className="space-y-4 mt-6">
      <div className="flex items-start justify-between gap-3 border-t border-input/50 pt-6">
        <div className="flex items-start gap-3 w-full">
          <div className="flex flex-col gap-1 w-full">
            <Header
              title="Runningbord Default Prompts"
              description="Pre-configured prompts with optimal model pairings. Selecting a prompt will automatically set the recommended AI model for best results."
            />
            {lastUpdated && (
              <div className="flex justify-end items-center gap-1 text-[10px] text-muted-foreground">
                <ClockIcon className="size-2" />
                <span>Last updated: {moment(lastUpdated).fromNow()}</span>
              </div>
            )}
          </div>
        </div>
        {!hasActiveLicense && (
          <GetLicense buttonText="Unlock" buttonClassName="shrink-0" />
        )}
      </div>

      <div
        className={`grid grid-cols-1 gap-4 @lg:grid-cols-2 @2xl:grid-cols-3 @4xl:grid-cols-4 pb-4 ${
          !hasActiveLicense ? "opacity-60" : ""
        }`}
      >
        {prompts.map((prompt, index) => {
          const isSelected = isPromptSelected(prompt);
          return (
            <Card
              key={`${prompt.title}-${index}`}
              className={`relative border lg:border-2 shadow-none p-4 pb-10 gap-0 group transition-all hover:shadow-sm ${
                hasActiveLicense ? "cursor-pointer" : "cursor-not-allowed"
              } ${
                isSelected
                  ? "!bg-primary/5 dark:!bg-primary/10 border-primary"
                  : "!bg-black/5 dark:!bg-white/5 border-transparent"
              }`}
              onClick={() => handleCardClick(prompt)}
            >
              {isSelected && (
                <CheckCircle2 className="size-5 text-green-500 flex-shrink-0 absolute top-2 right-2" />
              )}
              {!hasActiveLicense && (
                <LockIcon className="size-4 text-muted-foreground flex-shrink-0 absolute top-2 right-2" />
              )}
              <CardHeader className="p-0 pb-0 select-none">
                <div className="flex items-start justify-between gap-2 relative">
                  <div className="flex-1 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <CardTitle className="text-[10px] text-base line-clamp-1 flex-1 pr-3">
                        {prompt.title}
                      </CardTitle>
                    </div>
                    <CardDescription className="h-14 line-clamp-3 text-xs leading-relaxed">
                      {prompt.prompt}
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <div className="absolute bottom-2 left-4 w-full flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-[10px] lg:text-xs text-muted-foreground select-none">
                  <BotIcon className="size-3" />
                  <span className="line-clamp-1 max-w-[180px]">
                    {prompt.modelName}
                  </span>
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
};
