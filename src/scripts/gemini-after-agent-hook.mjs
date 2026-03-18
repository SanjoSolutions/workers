#!/usr/bin/env node

import { readStdin, parsePayload, determineStatus, writeStatus } from "./hook-utils.mjs";

function extractAgentMessage(payload) {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  // Gemini CLI AfterAgent hook payload field (AfterAgentInput.prompt_response)
  if (typeof payload.prompt_response === "string") {
    return payload.prompt_response;
  }
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
const payload = parsePayload(payloadText);

const agentMessage = extractAgentMessage(payload);
const statusFile = process.env.WORKERS_GEMINI_STATUS_FILE;

if (!statusFile) {
  process.exit(0);
}

const status = determineStatus(
  agentMessage,
  process.env.WORKERS_LOCAL_TODO_PATH,
  process.env.WORKERS_TODO_SUMMARY,
);

writeStatus(statusFile, { status });
