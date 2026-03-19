import { writeFileSync } from "fs";
import { describe, expect, test, vi, beforeEach } from "vitest";
import * as child_process from "child_process";
import { EventEmitter } from "events";

vi.mock("child_process");

function mockCodexSelection(lastMessage: string, exitCode = 0) {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();

  vi.mocked(child_process.spawn).mockImplementationOnce((_command, args) => {
    const outputIndex = args.findIndex((value) => value === "-o" || value === "--output-last-message");
    if (outputIndex >= 0) {
      const outputPath = args[outputIndex + 1];
      if (typeof outputPath === "string") {
        writeFileSync(outputPath, lastMessage, "utf8");
      }
    }
    return proc;
  });

  process.nextTick(() => {
    proc.emit("close", exitCode);
  });
}

const { evaluateCodexSelection } = await import("./model-selection.js");

describe("evaluateCodexSelection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("returns model and reasoning effort from Codex schema output", async () => {
    mockCodexSelection(JSON.stringify({
      model: "gpt-5.4-mini",
      reasoningEffort: "medium",
    }));

    const selection = await evaluateCodexSelection("- Add billing retries", {
      candidateModels: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex"],
      fallbackModel: "gpt-5.4",
      fallbackReasoningEffort: "high",
    });

    expect(selection).toEqual({
      model: "gpt-5.4-mini",
      reasoningEffort: "medium",
    });
  });

  test("passes Codex exec schema flags and candidate model context", async () => {
    mockCodexSelection(JSON.stringify({
      model: "gpt-5.4",
      reasoningEffort: "high",
    }));

    await evaluateCodexSelection("- Refactor auth middleware", {
      candidateModels: ["gpt-5.4", "gpt-5.4-mini"],
      fallbackModel: "gpt-5.4",
      fallbackReasoningEffort: "high",
    });

    expect(child_process.spawn).toHaveBeenCalledWith(
      "codex",
      expect.arrayContaining([
        "exec",
        "--model",
        "gpt-5.4",
        "--output-schema",
        expect.any(String),
        "-o",
        expect.any(String),
      ]),
      expect.any(Object),
    );
  });

  test("falls back when Codex returns a model outside the configured candidate set", async () => {
    mockCodexSelection(JSON.stringify({
      model: "gpt-4.1",
      reasoningEffort: "low",
    }));

    const selection = await evaluateCodexSelection("- Do something", {
      candidateModels: ["gpt-5.4", "gpt-5.4-mini"],
      fallbackModel: "gpt-5.4-mini",
      fallbackReasoningEffort: "high",
    });

    expect(selection).toEqual({
      model: "gpt-5.4-mini",
      reasoningEffort: "low",
    });
  });

  test("falls back when Codex returns an invalid reasoning effort", async () => {
    mockCodexSelection(JSON.stringify({
      model: "gpt-5.4",
      reasoningEffort: "maximum",
    }));

    const selection = await evaluateCodexSelection("- Do something", {
      candidateModels: ["gpt-5.4"],
      fallbackModel: "gpt-5.4",
      fallbackReasoningEffort: "high",
    });

    expect(selection).toEqual({
      model: "gpt-5.4",
      reasoningEffort: "high",
    });
  });
});
