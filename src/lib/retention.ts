import { deleteConversationsUpdatedBefore } from "./database/chat-history.action";
import { getConversationSettings } from "./storage/conversation.storage";

const DAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
let started = false;

/** Delete conversations older than the retention setting. Returns how many. */
export async function applyRetention(): Promise<number> {
  const { retentionDays } = getConversationSettings();
  if (!retentionDays) return 0;
  try {
    return await deleteConversationsUpdatedBefore(Date.now() - retentionDays * DAY_MS);
  } catch (error) {
    console.error("Failed to delete old conversations:", error);
    return 0;
  }
}

/** Apply the retention setting at launch and then hourly. */
export function startRetentionSweep() {
  if (started) return;
  started = true;
  applyRetention();
  setInterval(applyRetention, SWEEP_INTERVAL_MS);
}
