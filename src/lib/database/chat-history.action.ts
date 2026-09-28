import { getDatabase } from "./config";
import { ChatConversation } from "@/types";
import { safeLocalStorage } from "@/lib";

// Legacy localStorage key for migration purposes
const LEGACY_CHAT_HISTORY_KEY = "chat_history";

/**
 * Database conversation type (flattened for SQL)
 */
interface DbConversation {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
}

/**
 * Database message type (flattened for SQL)
 */
interface DbMessage {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  attached_files: string | null; // JSON string
}

/**
 * Safely parse JSON with error handling
 */
function safeJsonParse<T>(jsonString: string | null, fallback: T): T {
  if (!jsonString) return fallback;
  try {
    return JSON.parse(jsonString) as T;
  } catch (error) {
    console.error("Failed to parse JSON:", error);
    return fallback;
  }
}

/**
 * Validate message data
 */
function validateMessage(message: any): boolean {
  if (!message.id || typeof message.id !== "string") {
    console.error("Invalid message: missing or invalid id");
    return false;
  }
  if (
    !message.role ||
    !["user", "assistant", "system"].includes(message.role)
  ) {
    console.error("Invalid message: missing or invalid role");
    return false;
  }
  if (typeof message.content !== "string") {
    console.error("Invalid message: content must be a string");
    return false;
  }
  if (typeof message.timestamp !== "number" || message.timestamp < 0) {
    console.error("Invalid message: invalid timestamp");
    return false;
  }
  return true;
}

/**
 * Conversation list for the history page: metadata and message counts only.
 * Messages are loaded per conversation with getConversationById.
 */
export async function listConversations(): Promise<ChatConversation[]> {
  const db = await getDatabase();
  const rows = await db.select<(DbConversation & { message_count: number })[]>(
    `SELECT c.id, c.title, c.created_at, c.updated_at, COUNT(m.id) AS message_count
     FROM conversations c
     LEFT JOIN messages m ON m.conversation_id = c.id
     GROUP BY c.id
     ORDER BY c.updated_at DESC`
  );
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messages: [],
    messageCount: row.message_count,
  }));
}

/**
 * Get a single conversation by ID
 */
export async function getConversationById(
  id: string
): Promise<ChatConversation | null> {
  if (!id || typeof id !== "string") {
    console.error("Invalid conversation id");
    return null;
  }

  const db = await getDatabase();

  try {
    // Get conversation
    const conversations = await db.select<DbConversation[]>(
      "SELECT * FROM conversations WHERE id = ?",
      [id]
    );

    if (conversations.length === 0) {
      return null;
    }

    const conv = conversations[0];

    // Get messages
    const messages = await db.select<DbMessage[]>(
      "SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC",
      [id]
    );

    return {
      id: conv.id,
      title: conv.title,
      createdAt: conv.created_at,
      updatedAt: conv.updated_at,
      messages: messages.map((msg) => ({
        id: msg.id,
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp,
        attachedFiles: safeJsonParse(msg.attached_files, undefined),
      })),
    };
  } catch (error) {
    console.error(`Failed to get conversation ${id}:`, error);
    return null;
  }
}

// Writes per conversation run strictly in order, so two turns finishing close
// together can't interleave.
const writeQueues = new Map<string, Promise<unknown>>();

function enqueueWrite<T>(conversationId: string, task: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(conversationId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  writeQueues.set(conversationId, next);
  const cleanup = () => {
    if (writeQueues.get(conversationId) === next) writeQueues.delete(conversationId);
  };
  next.then(cleanup, cleanup);
  return next;
}

/**
 * Append messages to a conversation, creating it on first use. Append-only:
 * existing messages are never rewritten, so a stale in-memory copy can't
 * delete turns, and re-sending the same message ids is a no-op.
 */
export async function appendMessages(
  conversation: { id: string; title: string; createdAt: number },
  messages: ChatConversation["messages"]
): Promise<void> {
  if (!conversation.id || typeof conversation.id !== "string") {
    throw new Error("Invalid conversation id");
  }
  const valid = messages.filter(validateMessage);

  return enqueueWrite(conversation.id, async () => {
    const db = await getDatabase();
    const updatedAt = Math.max(Date.now(), ...valid.map((m) => m.timestamp));

    // The title is only set when the conversation is first created.
    await db.execute(
      `INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET updated_at = MAX(updated_at, excluded.updated_at)`,
      [
        conversation.id,
        conversation.title || "Untitled conversation",
        conversation.createdAt,
        updatedAt,
      ]
    );

    if (valid.length === 0) return;
    const placeholders = valid.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
    await db.execute(
      `INSERT OR IGNORE INTO messages (id, conversation_id, role, content, timestamp, attached_files) VALUES ${placeholders}`,
      valid.flatMap((message) => [
        message.id,
        conversation.id,
        message.role,
        message.content,
        message.timestamp,
        message.attachedFiles ? JSON.stringify(message.attachedFiles) : null,
      ])
    );
  });
}

/**
 * Delete a conversation and all its messages
 */
export async function deleteConversation(id: string): Promise<boolean> {
  if (!id || typeof id !== "string") {
    console.error("Invalid conversation id");
    return false;
  }

  const db = await getDatabase();

  try {
    const result = await db.execute("DELETE FROM conversations WHERE id = ?", [
      id,
    ]);

    return result.rowsAffected > 0;
  } catch (error) {
    console.error(`Failed to delete conversation ${id}:`, error);
    throw error;
  }
}

/**
 * Delete all conversations and messages
 */
export async function deleteAllConversations(): Promise<void> {
  const db = await getDatabase();

  try {
    // Delete in correct order (messages first due to foreign key)
    await db.execute("DELETE FROM messages");
    await db.execute("DELETE FROM conversations");
  } catch (error) {
    console.error("Failed to delete all conversations:", error);
    throw error;
  }
}

const MAX_TITLE_LENGTH = 80;

/**
 * First line of the user message, capped (prompts can carry long transcripts).
 */
export function generateConversationTitle(userMessage: string): string {
  const firstLine =
    userMessage
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? "";
  return firstLine.length > MAX_TITLE_LENGTH
    ? `${firstLine.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`
    : firstLine;
}

/**
 * Migrate chat history from localStorage to SQLite
 * This function safely moves all existing localStorage chat history to the database
 */
export async function migrateLocalStorageToSQLite(): Promise<{
  success: boolean;
  migratedCount: number;
  error?: string;
}> {
  const migrationKey = "chat_history_migrated_to_sqlite";

  try {
    // Check if migration has already been done
    if (safeLocalStorage.getItem(migrationKey) === "true") {
      return { success: true, migratedCount: 0 };
    }

    // Get existing localStorage data
    const existingData = safeLocalStorage.getItem(LEGACY_CHAT_HISTORY_KEY);
    if (!existingData) {
      // No data to migrate
      safeLocalStorage.setItem(migrationKey, "true");
      return { success: true, migratedCount: 0 };
    }

    // Parse localStorage conversations
    let conversations: ChatConversation[] = [];
    try {
      const parsed = JSON.parse(existingData);
      conversations = Array.isArray(parsed) ? parsed : [];
    } catch (parseError) {
      console.error("Failed to parse localStorage chat history:", parseError);
      // Mark as migrated anyway to prevent repeated failures
      safeLocalStorage.setItem(migrationKey, "true");
      return {
        success: false,
        migratedCount: 0,
        error: "Failed to parse localStorage data",
      };
    }

    if (conversations.length === 0) {
      // No valid data to migrate
      safeLocalStorage.setItem(migrationKey, "true");
      return { success: true, migratedCount: 0 };
    }

    // Get database instance
    const db = await getDatabase();

    // Migrate each conversation
    let migratedCount = 0;
    let errorCount = 0;

    for (const conversation of conversations) {
      try {
        // Validate conversation data
        if (!conversation?.id || !conversation?.title) {
          console.warn("Skipping invalid conversation:", conversation);
          errorCount++;
          continue;
        }

        // Check if conversation already exists in database
        const existing = await getConversationById(conversation.id);
        if (existing) {
          console.log(
            `Conversation ${conversation.id} already exists, skipping`
          );
          continue;
        }

        // Insert conversation
        await db.execute(
          "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
          [
            conversation.id,
            conversation.title,
            conversation.createdAt || Date.now(),
            conversation.updatedAt || Date.now(),
          ]
        );

        // Insert messages
        if (
          Array.isArray(conversation.messages) &&
          conversation.messages.length > 0
        ) {
          for (const message of conversation.messages) {
            // Validate message
            if (
              !message?.id ||
              !message?.role ||
              typeof message?.content !== "string"
            ) {
              console.warn(
                `Skipping invalid message in conversation ${conversation.id}:`,
                message
              );
              continue;
            }

            const attachedFilesJson = message.attachedFiles
              ? JSON.stringify(message.attachedFiles)
              : null;

            await db.execute(
              "INSERT INTO messages (id, conversation_id, role, content, timestamp, attached_files) VALUES (?, ?, ?, ?, ?, ?)",
              [
                message.id,
                conversation.id,
                message.role,
                message.content,
                message.timestamp || Date.now(),
                attachedFilesJson,
              ]
            );
          }
        }

        migratedCount++;
      } catch (convError) {
        console.error(
          `Failed to migrate conversation ${conversation?.id}:`,
          convError
        );
        errorCount++;
        // Clean up partially migrated conversation
        await db
          .execute("DELETE FROM conversations WHERE id = ?", [conversation?.id])
          .catch(() => {});
      }
    }

    // Mark migration as complete even if some failed
    safeLocalStorage.setItem(migrationKey, "true");

    // Clear localStorage chat history after migration attempt
    safeLocalStorage.removeItem(LEGACY_CHAT_HISTORY_KEY);

    const message =
      errorCount > 0
        ? `Migrated ${migratedCount}/${conversations.length} conversations (${errorCount} failed)`
        : `Successfully migrated ${migratedCount} conversations`;

    console.log(message);

    return {
      success: migratedCount > 0 || errorCount === 0,
      migratedCount,
      error:
        errorCount > 0
          ? `${errorCount} conversations failed to migrate`
          : undefined,
    };
  } catch (error) {
    console.error("Migration failed:", error);
    // Mark as attempted to prevent infinite retry loops
    safeLocalStorage.setItem(migrationKey, "true");
    return {
      success: false,
      migratedCount: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
