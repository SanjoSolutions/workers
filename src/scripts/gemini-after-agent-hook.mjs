#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "fs";

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      resolve(data);
    });
    process.stdin.on("error", reject);
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

function extractAgentMessage(payload) {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  // Gemini AfterAgent hook provides the agent message in these fields
  if (typeof payload.last_assistant_message === "string") {
    return payload.last_assistant_message;
  }
  if (typeof payload.agentMessage === "string") {
    return payload.agentMessage;
  }
  if (typeof payload.response === "string") {
    return payload.response;
  }
  if (typeof payload.message === "string") {
    return payload.message;
  }
  if (typeof payload.output === "string") {
    return payload.output;
  }

  return undefined;
}

const payloadText = await readStdin();
let payload = {};
if (payloadText.trim()) {
  try {
    payload = JSON.parse(payloadText);
  } catch {
    payload = {};
  }
}

const agentMessage = extractAgentMessage(payload);
const statusFile = process.env.WORKERS_GEMINI_STATUS_FILE;

if (!statusFile) {
  process.exit(0);
}

let status = "continue";
if (hasMarker(agentMessage, "WORKERS_STATUS: NEEDS_USER")) {
  status = "needs_user";
} else if (hasMarker(agentMessage, "WORKERS_STATUS: DONE")) {
  status = "done";
} else if (
  !todoStillContainsSummary(
    process.env.WORKERS_LOCAL_TODO_PATH,
    process.env.WORKERS_TODO_SUMMARY,
  )
) {
  status = "done";
}

writeFileSync(
  statusFile,
  `${JSON.stringify({
    status,
    updatedAt: new Date().toISOString(),
  })}\n`,
  "utf8",
);
