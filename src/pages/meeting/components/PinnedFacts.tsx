import { useState } from "react";
import { PinIcon, XIcon } from "lucide-react";
import { Button, Header, Input } from "@/components";
import {
  clearPinnedFacts,
  MAX_PINNED_FACT_LENGTH,
  MAX_PINNED_FACTS,
  pinFact,
  unpinFact,
  usePinnedFacts,
} from "@/lib";

export const PinnedFacts = () => {
  const facts = usePinnedFacts();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const add = () => {
    if (!text.trim()) return;
    if (pinFact(text)) {
      setText("");
      setError(null);
    } else {
      setError(
        facts.length >= MAX_PINNED_FACTS
          ? `You can pin up to ${MAX_PINNED_FACTS} facts.`
          : "That fact is already pinned."
      );
    }
  };

  return (
    <div id="pinned-facts" className="space-y-3">
      <Header
        title="Pinned Facts"
        description='Things every answer should take as true for this meeting, such as "Budget is $40k" or "They use Go and Postgres". Add them here or type "/pin <fact>" in the overlay; "/unpin all" clears them.'
        isMainTitle
      />
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <Input
          placeholder="e.g. Decision deadline is Friday"
          value={text}
          maxLength={MAX_PINNED_FACT_LENGTH}
          onChange={(e) => setText(e.target.value)}
        />
        <Button type="submit" disabled={!text.trim()}>
          <PinIcon className="size-4" /> Pin
        </Button>
      </form>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {facts.length > 0 && (
        <div className="space-y-1.5">
          {facts.map((fact) => (
            <div
              key={fact.id}
              className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm"
            >
              <span>{fact.text}</span>
              <Button
                size="icon"
                variant="ghost"
                className="size-7 shrink-0"
                title="Unpin"
                onClick={() => unpinFact(fact.id)}
              >
                <XIcon className="size-3.5" />
              </Button>
            </div>
          ))}
          <Button variant="ghost" size="sm" onClick={clearPinnedFacts}>
            Clear all
          </Button>
        </div>
      )}
    </div>
  );
};
