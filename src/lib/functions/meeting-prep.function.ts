import { TYPE_PROVIDER } from "@/types";
import { fetchAIResponse } from "./ai-response.function";

export type MeetingKind = "interview" | "sales-call" | "team-meeting" | "other";

export interface MeetingPrep {
  title: string;
  kind: MeetingKind;
  /** One of the user's profile names, when one fits. */
  profile: string | null;
  summary: string;
  attendees: { name: string; role?: string }[];
  agenda: string[];
  facts: string[];
  questions: string[];
}

const MAX_INPUT_CHARS = 30_000;

const prepPrompt = (text: string, profiles: string[]) => `Read the meeting information below (a calendar invite, agenda, email or job description) and prepare the user for the meeting.

Reply with only a JSON object, no Markdown and no code fence, in exactly this shape:
{
  "title": "short meeting title",
  "kind": "interview" | "sales-call" | "team-meeting" | "other",
  "profile": ${profiles.length ? `one of ${JSON.stringify(profiles)} if one clearly fits this meeting, otherwise null` : "null"},
  "summary": "two or three sentences: what the meeting is for and what the user should aim for",
  "attendees": [{ "name": "…", "role": "… (omit if unknown)" }],
  "agenda": ["…"],
  "facts": ["up to five short, concrete facts worth keeping in mind during the meeting (dates, numbers, names, requirements)"],
  "questions": ["up to five questions the user is likely to be asked or should be ready to answer"]
}
Use only what the text supports; use empty lists when something isn't mentioned.

<meeting_info>
${text.slice(0, MAX_INPUT_CHARS)}
</meeting_info>`;

const strings = (value: unknown, max: number) =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim()).slice(0, max)
    : [];

/** Parse the model's reply, tolerating a code fence or text around the JSON. */
export function parseMeetingPrep(reply: string, profiles: string[]): MeetingPrep {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The AI didn't return a meeting brief. Try again.");
  let data: any;
  try {
    data = JSON.parse(reply.slice(start, end + 1));
  } catch {
    throw new Error("The AI's meeting brief couldn't be read. Try again.");
  }
  const kinds: MeetingKind[] = ["interview", "sales-call", "team-meeting", "other"];
  return {
    title: typeof data.title === "string" && data.title.trim() ? data.title.trim().slice(0, 120) : "Meeting",
    kind: kinds.includes(data.kind) ? data.kind : "other",
    profile: typeof data.profile === "string" && profiles.includes(data.profile) ? data.profile : null,
    summary: typeof data.summary === "string" ? data.summary.trim() : "",
    attendees: Array.isArray(data.attendees)
      ? data.attendees
          .filter((a: any) => a && typeof a.name === "string" && a.name.trim())
          .slice(0, 20)
          .map((a: any) => ({
            name: a.name.trim(),
            role: typeof a.role === "string" && a.role.trim() ? a.role.trim() : undefined,
          }))
      : [],
    agenda: strings(data.agenda, 15),
    facts: strings(data.facts, 5),
    questions: strings(data.questions, 5),
  };
}

/** The brief as a My Context note. */
export function meetingBriefNote(prep: MeetingPrep): string {
  const section = (title: string, lines: string[]) =>
    lines.length ? `${title}:\n${lines.map((l) => `- ${l}`).join("\n")}` : "";
  return [
    prep.summary,
    section(
      "Attendees",
      prep.attendees.map((a) => (a.role ? `${a.name} (${a.role})` : a.name))
    ),
    section("Agenda", prep.agenda),
    section("Questions to be ready for", prep.questions),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function prepareMeeting({
  provider,
  selectedProvider,
  text,
  profiles,
}: {
  provider: TYPE_PROVIDER;
  selectedProvider: { provider: string; variables: Record<string, string> };
  text: string;
  profiles: string[];
}): Promise<MeetingPrep> {
  const vars = { ...selectedProvider.variables };
  delete vars.slow_model;
  let reply = "";
  for await (const chunk of fetchAIResponse({
    provider,
    selectedProvider: { ...selectedProvider, variables: vars },
    userMessage: prepPrompt(text, profiles),
  })) {
    reply += chunk;
  }
  return parseMeetingPrep(reply, profiles);
}
