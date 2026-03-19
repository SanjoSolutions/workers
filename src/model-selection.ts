import { spawn } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import * as log from "./log.js";

const VALID_CLAUDE_MODELS = new Set(["haiku", "sonnet", "opus"]);
const DEFAULT_CLAUDE_MODEL = "sonnet";
const VALID_CODEX_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);

const EVALUATION_PROMPT = `You are selecting which Claude model should execute an autonomous coding task.

Available models (cheapest to most expensive):
- haiku: Simple mechanical tasks — rename, config changes, doc updates, typo fixes, dependency bumps
- sonnet: Standard implementation — features, bug fixes, test writing, refactoring
- opus: Complex work — architecture, security reviews, subtle bugs, multi-file refactors, migrations, design decisions

Select the most appropriate model for the task below.

Task:
`;

const MODEL_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    model: {
      type: "string",
      enum: ["haiku", "sonnet", "opus"],
      description: "The Claude model best suited for this task",
    },
  },
  required: ["model"],
  additionalProperties: false,
});

interface EvaluationResult {
  model?: string;
}

interface CodexEvaluationResult {
  model?: string;
  reasoningEffort?: string;
}

export interface CodexSelectionOptions {
  candidateModels: string[];
  fallbackModel: string;
  fallbackReasoningEffort: string;
}

/**
 * Call the configured CLI to evaluate which model is best for a task.
 * Falls back to "sonnet" if the evaluation fails or returns an invalid model.
 */
export async function evaluateClaudeModel(todoItem: string): Promise<string> {
  const prompt = EVALUATION_PROMPT + todoItem;

  try {
    const result = await spawnEvaluation("claude", [
      "--model",
      "opus",
      "--effort",
      "high",
      "-p",
      prompt,
      "--json-schema",
      MODEL_SCHEMA,
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
      "--allowedTools",
      "",
    ]);

    const envelope = JSON.parse(result);
    const parsed: EvaluationResult = envelope.structured_output ?? {};
    const model = parsed.model?.trim().toLowerCase();

    if (model && VALID_CLAUDE_MODELS.has(model)) {
      log.info(`Model evaluation selected: ${model}`);
      return model;
    }

    log.warn(`Model evaluation returned invalid model "${parsed.model ?? ""}", using default`);
    return DEFAULT_CLAUDE_MODEL;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`Model evaluation failed: ${message}, using default`);
    return DEFAULT_CLAUDE_MODEL;
  }
}

function buildCodexEvaluationPrompt(todoItem: string, candidateModels: string[]): string {
  const modelLines = candidateModels.map((model) => `- ${model}`).join("\n");

  return `You are selecting which Codex model and reasoning effort should execute an autonomous coding task.

Candidate models:
${modelLines}

Available reasoning efforts:
- low: simple mechanical work
- medium: standard implementation work
- high: complex multi-file work or subtle debugging
- xhigh: only for especially difficult or ambiguous work

Choose the cheapest model and lowest reasoning effort that are still appropriate for the task.
Return only structured output that matches the provided schema.

Task:
${todoItem}`;
}

function buildCodexSchema(candidateModels: string[]): string {
  return JSON.stringify({
    type: "object",
    properties: {
      model: {
        type: "string",
        enum: candidateModels,
        description: "The Codex model best suited for this task",
      },
      reasoningEffort: {
        type: "string",
        enum: ["low", "medium", "high", "xhigh"],
        description: "The reasoning effort level best suited for this task",
      },
    },
    required: ["model", "reasoningEffort"],
    additionalProperties: false,
  });
}

export async function evaluateCodexSelection(
  todoItem: string,
  options: CodexSelectionOptions,
): Promise<{ model: string; reasoningEffort: string }> {
  const candidateModels = options.candidateModels.length > 0
    ? options.candidateModels
    : [options.fallbackModel];
  const evaluatorModel = candidateModels.includes("gpt-5.4")
    ? "gpt-5.4"
    : candidateModels[0];
  const prompt = buildCodexEvaluationPrompt(todoItem, candidateModels);
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "workers-codex-selection-"));
  const schemaPath = path.join(tempDir, "output-schema.json");
  const outputPath = path.join(tempDir, "last-message.json");

  try {
    writeFileSync(schemaPath, buildCodexSchema(candidateModels), "utf8");
    await spawnEvaluation("codex", [
      "exec",
      "--model",
      evaluatorModel,
      "--output-schema",
      schemaPath,
      "-o",
      outputPath,
      prompt,
    ]);

    const output = readFileSync(outputPath, "utf8");
    const parsed = JSON.parse(output) as CodexEvaluationResult;
    const model = parsed.model?.trim();
    const reasoningEffort = parsed.reasoningEffort?.trim().toLowerCase();

    const selectedModel = model && candidateModels.includes(model)
      ? model
      : options.fallbackModel;
    const selectedReasoningEffort = reasoningEffort && VALID_CODEX_REASONING_EFFORTS.has(reasoningEffort)
      ? reasoningEffort
      : options.fallbackReasoningEffort;

    if (selectedModel !== options.fallbackModel || selectedReasoningEffort !== options.fallbackReasoningEffort) {
      log.info(
        `Codex selection chose model ${selectedModel} with reasoning ${selectedReasoningEffort}`,
      );
    }

    if (selectedModel !== (model ?? options.fallbackModel)) {
      log.warn(`Codex selection returned invalid model "${parsed.model ?? ""}", using fallback`);
    }
    if (selectedReasoningEffort !== (reasoningEffort ?? options.fallbackReasoningEffort)) {
      log.warn(
        `Codex selection returned invalid reasoning effort "${parsed.reasoningEffort ?? ""}", using fallback`,
      );
    }

    return {
      model: selectedModel,
      reasoningEffort: selectedReasoningEffort,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`Codex selection failed: ${message}, using fallbacks`);
    return {
      model: options.fallbackModel,
      reasoningEffort: options.fallbackReasoningEffort,
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function spawnEvaluation(command: string, args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`${command} exited with code ${code}: ${stderr}`));
      }
    });

    child.on("error", (error) => {
      reject(error);
    });
  });
}
