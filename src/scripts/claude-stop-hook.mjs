#!/usr/bin/env node

import { readStdin, parsePayload, determineStatus, writeStatus } from "./hook-utils.mjs";

const payloadText = await readStdin();
const payload = parsePayload(payloadText);

const lastAssistantMessage =
  payload && typeof payload === "object" ? payload.last_assistant_message : undefined;
const statusFile = process.env.WORKERS_CLAUDE_STATUS_FILE;

if (!statusFile) {
  process.exit(0);
}

const status = determineStatus(
  lastAssistantMessage,
  process.env.WORKERS_LOCAL_TODO_PATH,
  process.env.WORKERS_TODO_SUMMARY,
);

writeStatus(statusFile, {
  status,
  sessionId:
    payload && typeof payload === "object" ? payload.session_id : undefined,
});
