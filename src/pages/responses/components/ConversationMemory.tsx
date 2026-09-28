import {
  Header,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components";
import {
  HISTORY_BUDGET_OPTIONS,
  IDLE_RESET_OPTIONS,
  useConversationSettings,
} from "@/lib";

const idleLabel = (minutes: number) => (minutes === 0 ? "Never" : `After ${minutes} min idle`);
const budgetLabel = (tokens: number) =>
  tokens === 0 ? "Unlimited" : `~${tokens / 1000}k tokens`;

export const ConversationMemory = () => {
  const [settings, setSettings] = useConversationSettings();

  return (
    <div id="conversation-memory" className="space-y-4">
      <Header
        title="Conversation Memory"
        description="Control how much of the current conversation the AI sees with each question. Less history is faster and cheaper; more history helps with follow-ups."
        isMainTitle
      />

      <div className="flex items-center justify-between gap-4 p-4 border rounded-xl">
        <div>
          <p className="text-sm font-medium">Start a new conversation</p>
          <p className="text-xs text-muted-foreground mt-1">
            So a question in your next meeting isn't answered with context from the last one.
            You can also start one any time with the New Conversation shortcut.
          </p>
        </div>
        <Select
          value={String(settings.idleResetMinutes)}
          onValueChange={(v) => setSettings({ idleResetMinutes: Number(v) })}
        >
          <SelectTrigger className="w-48 shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {IDLE_RESET_OPTIONS.map((m) => (
              <SelectItem key={m} value={String(m)}>
                {idleLabel(m)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center justify-between gap-4 p-4 border rounded-xl">
        <div>
          <p className="text-sm font-medium">History sent per question</p>
          <p className="text-xs text-muted-foreground mt-1">
            The most recent messages are kept until this budget is used; the last exchange is
            always included. Repeated meeting transcripts are de-duplicated automatically.
          </p>
        </div>
        <Select
          value={String(settings.historyBudgetTokens)}
          onValueChange={(v) => setSettings({ historyBudgetTokens: Number(v) })}
        >
          <SelectTrigger className="w-48 shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {HISTORY_BUDGET_OPTIONS.map((t) => (
              <SelectItem key={t} value={String(t)}>
                {budgetLabel(t)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
};
