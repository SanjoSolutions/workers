import { spawn } from "child_process";
import * as log from "./log.js";

const VALID_CLAUDE_MODELS = new Set(["haiku", "sonnet", "opus"]);
const DEFAULT_CLAUDE_MODEL = "sonnet";

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
      "--output-format",
      "json",
      "--json-schema",
      MODEL_SCHEMA,
      "--dangerously-skip-permissions",
      "--allowedTools",
      "",
    ]);

    const parsed: EvaluationResult = JSON.parse(result);
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
