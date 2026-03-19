/**
 * Workers pi interactive hook extension.
 * Listens to agent_end events and updates the workers status file.
 */

import { existsSync, readFileSync } from "fs";
import { writeStatus } from "./hook-utils.mjs";

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

function hasMarker(message, marker) {
  return typeof message === "string" && message.includes(marker);
}

function todoStillContainsSummary(localTodoPath, summary) {
  if (!localTodoPath || !summary || !existsSync(localTodoPath)) {
    return true;
  }
  try {
    const content = readFileSync(localTodoPath, "utf8");
    return content.includes(summary);
  } catch {
    return true;
  }
}

function determineStatus(message, localTodoPath, todoSummary) {
  if (hasMarker(message, "WORKERS_STATUS: NEEDS_USER")) {
    return "needs_user";
  }
  if (hasMarker(message, "WORKERS_STATUS: DONE")) {
    return "done";
  }
  if (!todoStillContainsSummary(localTodoPath, todoSummary)) {
    return "done";
  }
  return "continue";
}
