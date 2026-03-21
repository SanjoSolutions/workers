import { existsSync, readFileSync, writeFileSync } from "fs";

export function readStdin() {
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

export function hasMarker(message, marker) {
  return typeof message === "string" && message.includes(marker);
}

export function todoStillContainsSummary(localTodoPath, summary) {
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

export function parsePayload(payloadText) {
  if (!payloadText.trim()) {
    return {};
  }
  try {
    return JSON.parse(payloadText);
  } catch {
    return {};
  }
}

export function determineStatus(message, localTodoPath, todoSummary) {
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

export function writeStatus(statusFile, statusData) {
  let existingStatus = undefined;
  if (existsSync(statusFile)) {
    try {
      const parsed = JSON.parse(readFileSync(statusFile, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existingStatus = parsed;
      }
    } catch {
      existingStatus = undefined;
    }
  }

  writeFileSync(
    statusFile,
    `${JSON.stringify({
      ...(existingStatus ?? {}),
      ...statusData,
      updatedAt: new Date().toISOString(),
    })}\n`,
    "utf8",
  );
}
