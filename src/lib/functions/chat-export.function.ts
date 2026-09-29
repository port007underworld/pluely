import { invoke } from "@tauri-apps/api/core";
import moment from "moment";
import { getAllConversations } from "@/lib/database/chat-history.action";
import { ChatConversation } from "@/types";

export type ExportFormat = "markdown" | "json";

const ROLE_LABEL = { user: "You", assistant: "Assistant", system: "System" } as const;

/** Attachments are listed by name; image and audio data is left out. */
const attachmentSummary = (files: ChatConversation["messages"][number]["attachedFiles"]) =>
  files?.length ? `\n\n_Attachments: ${files.map((f) => f.name).join(", ")}_` : "";

export function conversationsToMarkdown(conversations: ChatConversation[]): string {
  return conversations
    .map((conv) => {
      const header = `# ${conv.title}\n\n_${moment(conv.createdAt).format("LLLL")}_`;
      const messages = conv.messages.map(
        (m) =>
          `## ${ROLE_LABEL[m.role]} · ${moment(m.timestamp).format("LT")}\n\n${m.content}${attachmentSummary(m.attachedFiles)}`
      );
      return [header, ...messages].join("\n\n");
    })
    .join("\n\n---\n\n");
}

export function conversationsToJson(conversations: ChatConversation[]): string {
  const stripped = conversations.map((conv) => ({
    ...conv,
    messages: conv.messages.map(({ attachedFiles, ...m }) => ({
      ...m,
      ...(attachedFiles?.length && {
        attachments: attachedFiles.map(({ name, type }) => ({ name, type })),
      }),
    })),
  }));
  return JSON.stringify({ exportedAt: new Date().toISOString(), conversations: stripped }, null, 2);
}

/**
 * Save conversations to a file the user picks. Exports everything when no
 * conversations are passed. Returns the saved path, or null if cancelled.
 */
export async function exportConversations(
  format: ExportFormat,
  conversations?: ChatConversation[]
): Promise<string | null> {
  const list = conversations ?? (await getAllConversations());
  const contents =
    format === "json" ? conversationsToJson(list) : conversationsToMarkdown(list);
  const base =
    conversations?.length === 1
      ? conversations[0].title.replace(/[\\/:*?"<>|]+/g, "").slice(0, 60).trim() || "conversation"
      : `runningbord-chats-${moment().format("YYYY-MM-DD")}`;
  return invoke<string | null>("save_export", {
    defaultName: `${base}.${format === "json" ? "json" : "md"}`,
    contents,
  });
}
