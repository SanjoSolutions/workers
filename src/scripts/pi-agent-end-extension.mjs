/**
 * Workers pi interactive hook extension.
 * Listens to agent_end events and updates the workers status file.
 */

import { determineStatus, writeStatus } from "./hook-utils.mjs";

export default function (pi) {
  pi.on("agent_end", async (event) => {
    const statusFile = process.env.WORKERS_PI_STATUS_FILE;
    if (!statusFile) return;

    const messages = event.messages ?? [];
    let lastAssistantText = "";
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant") {
        const content = msg.content;
        if (Array.isArray(content)) {
          lastAssistantText = content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n");
        } else if (typeof content === "string") {
          lastAssistantText = content;
        }
        break;
      }
    }

    const status = determineStatus(
      lastAssistantText,
      process.env.WORKERS_LOCAL_TODO_PATH,
      process.env.WORKERS_TODO_SUMMARY,
    );
    writeStatus(statusFile, { status });
  });
}
