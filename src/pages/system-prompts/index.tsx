import {
  Input,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Button,
  Empty,
} from "@/components";
import { useSystemPrompts } from "@/hooks";
import {
  Search,
  MoreHorizontal,
  PlusIcon,
  Pencil,
  Trash2,
  CheckCircle2,
  WandSparklesIcon,
} from "lucide-react";
import { DeleteSystemPrompt } from "./Delete";
import { CreateEditDialog } from "./CreateEditDialog";
import { RunningbordPrompts } from "./RunningbordPrompts";
import { useState } from "react";
import { PageLayout } from "@/layouts";
import { DEFAULT_PRESET_ID, PROMPT_PRESETS } from "@/config";

const SystemPrompts = () => {
  const {
    prompts,
    isLoading,
    error,
    createPrompt,
    deletePrompt,
    updatePrompt,
    selectedPromptId,
    handleSelectPrompt,
    clearError,
    selectedPresetId,
    handleSelectPreset,
    copyPreset,
  } = useSystemPrompts();

  const [search, setSearch] = useState("");
  const [isCreateEditDialogOpen, setIsCreateEditDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [form, setForm] = useState<{
    id?: number;
    name: string;
    prompt: string;
  }>({
    name: "",
    prompt: "",
  });

  /**
   * Handle opening create dialog
   */
  const handleCreateClick = () => {
    setForm({ name: "", prompt: "" });
    setIsCreateEditDialogOpen(true);
  };

  /**
   * Handle opening edit dialog
   */
  const handleEditClick = (promptId: number) => {
    const promptToEdit = prompts.find((p) => p.id === promptId);
    if (promptToEdit) {
      setForm({
        id: promptToEdit.id,
        name: promptToEdit.name,
        prompt: promptToEdit.prompt,
      });
      setIsCreateEditDialogOpen(true);
    }
  };

  /**
   * Handle opening delete dialog
   */
  const handleDeleteClick = (promptId: number) => {
    const promptToDelete = prompts.find((p) => p.id === promptId);
    if (promptToDelete) {
      setForm({
        id: promptToDelete.id,
        name: promptToDelete.name,
        prompt: promptToDelete.prompt,
      });
      setIsDeleteDialogOpen(true);
    }
  };

  /**
   * Handle saving (create or update)
   */
  const handleSave = async () => {
    try {
      setIsSaving(true);
      clearError();

      if (form.id) {
        // Update existing prompt
        await updatePrompt(form.id, {
          name: form.name,
          prompt: form.prompt,
        });
      } else {
        // Create new prompt
        const newPrompt = await createPrompt({
          name: form.name,
          prompt: form.prompt,
        });
        // Auto-select the newly created prompt
        handleSelectPrompt(newPrompt.id);
      }

      setForm({ name: "", prompt: "" });
      setIsCreateEditDialogOpen(false);
    } catch (err) {
      console.error("Failed to save prompt:", err);
    } finally {
      setIsSaving(false);
    }
  };

  /**
   * Handle delete confirmation
   */
  const handleDeleteConfirm = async (id: number) => {
    await deletePrompt(id);
    setForm({ name: "", prompt: "" });
    setIsDeleteDialogOpen(false);
  };

  /**
   * Handle AI generation
   */
  const handleGenerate = (
    generatedPrompt: string,
    generatedPromptName: string
  ) => {
    setForm((prev) => ({
      ...prev,
      prompt: generatedPrompt,
      name: generatedPromptName,
    }));
  };

  /**
   * Handle selecting a prompt card
   */
  const handleCardClick = (promptId: number) => {
    handleSelectPrompt(promptId);
  };

  /**
   * Filter prompts based on search
   */
  const filteredPrompts = prompts.filter(
    (prompt) =>
      prompt.name.toLowerCase().includes(search.toLowerCase()) ||
      prompt.prompt.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <PageLayout
      title="System Prompts"
      description="Manage your AI behavior profiles and create new ones"
    >
      {/* Error Display */}
      {error && (
        <div className="mb-4 rounded-lg border border-destructive/20 bg-destructive/10 p-3">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}
      {/* Built-in presets */}
      <div className="space-y-2">
        <div>
          <h3 className="text-sm font-semibold">Built-in presets</h3>
          <p className="text-xs text-muted-foreground">
            Tuned for technical work: they answer what you actually need and ignore incidental
            details on screen. Customize one to make an editable copy in your prompts.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-3 @lg:grid-cols-2 @4xl:grid-cols-4">
          {PROMPT_PRESETS.map((preset) => {
            const isSelected = selectedPresetId === preset.id;
            return (
              <Card
                key={preset.id}
                className={`relative border lg:border-2 shadow-none p-4 pb-10 gap-0 cursor-pointer transition-all hover:shadow-sm ${
                  isSelected
                    ? "!bg-primary/5 dark:!bg-primary/10 border-primary"
                    : "!bg-black/5 dark:!bg-white/5 border-transparent"
                }`}
                onClick={() => handleSelectPreset(preset.id)}
              >
                {isSelected && (
                  <CheckCircle2 className="size-5 text-green-500 flex-shrink-0 absolute top-2 right-2" />
                )}
                <CardHeader className="p-0 select-none">
                  <CardTitle className="text-sm pr-5">
                    {preset.name}
                    {preset.id === DEFAULT_PRESET_ID && (
                      <span className="ml-2 text-[10px] font-normal text-muted-foreground">
                        default
                      </span>
                    )}
                  </CardTitle>
                  <CardDescription className="text-xs leading-relaxed">
                    {preset.description}
                  </CardDescription>
                </CardHeader>
                <button
                  type="button"
                  className="absolute bottom-2 left-4 text-[11px] text-muted-foreground underline-offset-2 hover:underline hover:text-foreground"
                  onClick={(e) => {
                    e.stopPropagation();
                    copyPreset(preset).catch(() => {});
                  }}
                >
                  Customize
                </button>
              </Card>
            );
          })}
        </div>
      </div>

      <h3 className="text-sm font-semibold pt-2">Your prompts</h3>

      {/* Search Bar */}
      <div className="flex items-center gap-2 justify-between">
        <div className="relative w-full @lg:w-1/2 @3xl:w-1/3 select-none">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="text"
            placeholder="Search system prompts..."
            className="pl-9 focus-visible:ring-0 focus-visible:ring-offset-0"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Button variant="default" size="default" onClick={handleCreateClick}>
          <PlusIcon className="size-4" />
          Create New
        </Button>
      </div>
      {filteredPrompts.length === 0 ? (
        <Empty
          isLoading={isLoading}
          icon={WandSparklesIcon}
          title="No prompts found"
          description="Create a new prompt to get started"
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 @lg:grid-cols-2 @2xl:grid-cols-3 @4xl:grid-cols-4 pb-4">
          {filteredPrompts.reverse().map((prompt) => {
            const isSelected = selectedPromptId === prompt.id;
            return (
              <Card
                key={prompt.id}
                className={`relative border  lg:border-2 shadow-none p-4 pb-10 gap-0 group cursor-pointer transition-all hover:shadow-sm ${
                  isSelected
                    ? "!bg-primary/5 dark:!bg-primary/10 border-primary"
                    : "!bg-black/5 dark:!bg-white/5 border-transparent"
                }`}
                onClick={() => handleCardClick(prompt.id)}
              >
                {isSelected && (
                  <CheckCircle2 className="size-5 text-green-500 flex-shrink-0 absolute top-2 right-2" />
                )}
                <CardHeader className="p-0 pb-0 select-none">
                  <div className="flex items-start justify-between gap-2 relative">
                    <div className="flex-1 space-y-1.5">
                      <div className="flex items-center gap-2">
                        <CardTitle className="text-[10px] text-base line-clamp-1 flex-1 pr-3">
                          {prompt.name}
                        </CardTitle>
                      </div>
                      <CardDescription className="h-14 line-clamp-3 text-xs leading-relaxed">
                        {prompt.prompt}
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <div className="absolute bottom-2 left-4 w-full flex items-center justify-between">
                  <span className="text-[10px] lg:text-xs text-muted-foreground select-none">
                    {prompt.created_at}
                  </span>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild className="mr-6">
                      <button
                        className="flex size-8 items-center justify-center rounded-xl transition-opacity hover:bg-accent"
                        onClick={(e) => {
                          e.stopPropagation();
                        }}
                      >
                        <MoreHorizontal className="size-4 text-muted-foreground" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-40">
                      <DropdownMenuItem
                        onClick={(e) => {
                          e.stopPropagation();
                          handleEditClick(prompt.id);
                        }}
                      >
                        <Pencil className="size-4 mr-2" />
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteClick(prompt.id);
                        }}
                      >
                        <Trash2 className="size-4 mr-2" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Create/Edit Dialog */}
      <CreateEditDialog
        isOpen={isCreateEditDialogOpen}
        onOpenChange={setIsCreateEditDialogOpen}
        form={form}
        setForm={setForm}
        onSave={handleSave}
        onGenerate={handleGenerate}
        isEditing={!!form.id}
        isSaving={isSaving}
      />

      {/* Delete Confirmation Dialog */}
      <DeleteSystemPrompt
        isOpen={isDeleteDialogOpen}
        onOpenChange={setIsDeleteDialogOpen}
        promptId={form.id}
        promptName={form.name}
        onDelete={handleDeleteConfirm}
      />

      {/* Runningbord Default Prompts */}
      <RunningbordPrompts />
    </PageLayout>
  );
};

export default SystemPrompts;
