import { useState } from "react";
import { Header, Switch } from "@/components";
import { getResponseSettings, updateSuggestFollowUps } from "@/lib";

export const FollowUpsToggle = () => {
  const [enabled, setEnabled] = useState(() => getResponseSettings().suggestFollowUps);

  return (
    <div id="follow-ups" className="space-y-3">
      <Header
        title="Suggested Follow-ups"
        description="End each overlay answer with two or three questions likely to come next, shown as buttons. Click one to get its answer ready before it's asked."
        isMainTitle
      />
      <div className="flex items-center justify-between gap-4 p-4 border rounded-xl">
        <div>
          <p className="text-sm font-medium">Suggest likely follow-up questions</p>
          <p className="text-xs text-muted-foreground mt-1">
            Adds a few lines to each answer; no extra requests.
          </p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={(checked) => {
            setEnabled(checked);
            updateSuggestFollowUps(checked);
          }}
        />
      </div>
    </div>
  );
};
