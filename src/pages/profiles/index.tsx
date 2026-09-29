import { useState } from "react";
import { CheckIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { Badge, Button, Input } from "@/components";
import { useApp } from "@/contexts";
import { PageLayout } from "@/layouts";
import {
  createProfile,
  deleteProfile,
  getPreset,
  Profile,
  renameProfile,
  switchProfile,
  useProfiles,
} from "@/lib";
import { cn } from "@/lib/utils";

const TEMPLATES = [
  { name: "Interview", presetId: "interview" },
  { name: "Sales call", presetId: "sales-call" },
  { name: "Team meeting", presetId: "team-meeting" },
];

const summary = (profile: Profile) => {
  const prompt =
    getPreset(profile.systemPrompt.presetId ?? null)?.name ??
    (profile.systemPrompt.promptId ? "Your prompt" : "Custom prompt");
  const context = profile.contextEnabled
    ? `${profile.contextItemIds.length} context item${profile.contextItemIds.length === 1 ? "" : "s"}`
    : "Context off";
  return [prompt, context, profile.model, `${profile.responseSettings.responseLength} answers`]
    .filter(Boolean)
    .join(" · ");
};

const Profiles = () => {
  const { selectedAIProvider, onSetSelectedAIProvider, setSystemPrompt } = useApp();
  const { activeId, profiles } = useProfiles();
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apply = (result: { systemPrompt: string; ai: typeof selectedAIProvider }) => {
    setSystemPrompt(result.systemPrompt);
    if (result.ai !== selectedAIProvider) onSetSelectedAIProvider(result.ai);
  };

  const run = (action: () => void) => {
    setError(null);
    try {
      action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const create = (name: string, presetId?: string) =>
    run(() => {
      apply(createProfile(name, selectedAIProvider, presetId));
      setNewName("");
    });

  return (
    <PageLayout
      title="Profiles"
      description="A profile remembers your system prompt, which context items are on, the model and the response style for one kind of meeting. Changes you make while a profile is active are saved to it when you switch."
    >
      <div className="space-y-3">
        {profiles.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No profiles yet. Save your current settings as one, or start from a template.
          </p>
        )}
        {profiles.map((profile) => {
          const active = profile.id === activeId;
          return (
            <div
              key={profile.id}
              className={cn(
                "flex items-center justify-between gap-4 p-4 border rounded-xl",
                active && "border-primary/60"
              )}
            >
              <div className="min-w-0">
                {renaming?.id === profile.id ? (
                  <form
                    className="flex gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      renameProfile(profile.id, renaming.name);
                      setRenaming(null);
                    }}
                  >
                    <Input
                      autoFocus
                      value={renaming.name}
                      onChange={(e) => setRenaming({ id: profile.id, name: e.target.value })}
                      className="h-8"
                    />
                    <Button size="sm" type="submit">
                      Save
                    </Button>
                  </form>
                ) : (
                  <p className="text-sm font-medium flex items-center gap-2">
                    {profile.name}
                    {active && <Badge variant="secondary">Active</Badge>}
                  </p>
                )}
                <p className="text-xs text-muted-foreground mt-1 truncate">{summary(profile)}</p>
              </div>
              <div className="flex gap-1 shrink-0">
                {!active && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => run(() => apply(switchProfile(profile.id, selectedAIProvider)))}
                  >
                    <CheckIcon className="size-4" /> Use
                  </Button>
                )}
                <Button
                  size="icon"
                  variant="ghost"
                  title="Rename"
                  onClick={() => setRenaming({ id: profile.id, name: profile.name })}
                >
                  <PencilIcon className="size-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  title="Delete profile (your current settings stay as they are)"
                  onClick={() => deleteProfile(profile.id)}
                >
                  <Trash2Icon className="size-4" />
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="space-y-2 p-4 border rounded-xl">
        <p className="text-sm font-medium">New profile</p>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (newName.trim()) create(newName);
          }}
        >
          <Input
            placeholder="Name, e.g. Acme interview loop"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <Button type="submit" disabled={!newName.trim()}>
            <PlusIcon className="size-4" /> Save current settings
          </Button>
        </form>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <span className="text-xs text-muted-foreground">Or start from a template:</span>
          {TEMPLATES.map((t) => (
            <Button key={t.presetId} size="sm" variant="outline" onClick={() => create(t.name, t.presetId)}>
              {t.name}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Templates use your current context, model and response settings with a prompt for that kind
          of meeting; adjust them after switching.
        </p>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}
    </PageLayout>
  );
};

export default Profiles;
