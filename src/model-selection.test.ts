import { describe, expect, test, vi, beforeEach } from "vitest";
import * as child_process from "child_process";
import { EventEmitter } from "events";

vi.mock("child_process");

function mockSpawn(stdout: string, exitCode = 0) {
  const proc = new EventEmitter() as any;
  const stdoutEmitter = new EventEmitter() as any;
  const stderrEmitter = new EventEmitter() as any;
  proc.stdout = stdoutEmitter;
  proc.stderr = stderrEmitter;

  vi.mocked(child_process.spawn).mockReturnValueOnce(proc);

  process.nextTick(() => {
    if (stdout) stdoutEmitter.emit("data", Buffer.from(stdout));
    proc.emit("close", exitCode);
  });

  return proc;
}

function jsonResponse(model: string) {
  return JSON.stringify({ model });
}

const { evaluateClaudeModel } = await import("./model-selection.js");

describe("evaluateClaudeModel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("returns model from structured JSON response", async () => {
    mockSpawn(jsonResponse("opus"));
    const model = await evaluateClaudeModel("- Redesign the API architecture");
    expect(model).toBe("opus");
  });

  test("passes correct flags to claude CLI", async () => {
    mockSpawn(jsonResponse("sonnet"));
    await evaluateClaudeModel("- Add user auth");

    expect(child_process.spawn).toHaveBeenCalledWith(
      "claude",
      expect.arrayContaining([
        "--model", "opus",
        "--effort", "high",
        "--output-format", "json",
        "--json-schema",
        "-p",
      ]),
      expect.any(Object),
    );
  });

  test("handles all valid model values", async () => {
    for (const model of ["haiku", "sonnet", "opus"]) {
      vi.clearAllMocks();
      mockSpawn(jsonResponse(model));
      const result = await evaluateClaudeModel("- Some task");
      expect(result).toBe(model);
    }
  });

  test("falls back to sonnet on invalid model in JSON", async () => {
    mockSpawn(JSON.stringify({ model: "gpt-4" }));
    const model = await evaluateClaudeModel("- Do something");
    expect(model).toBe("sonnet");
  });

  test("falls back to sonnet on malformed JSON", async () => {
    mockSpawn("not json at all");
    const model = await evaluateClaudeModel("- Do something");
    expect(model).toBe("sonnet");
  });

  test("falls back to sonnet on non-zero exit", async () => {
    mockSpawn("", 1);
    const model = await evaluateClaudeModel("- Do something");
    expect(model).toBe("sonnet");
  });

  test("falls back to sonnet on spawn error", async () => {
    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    vi.mocked(child_process.spawn).mockReturnValueOnce(proc);
    process.nextTick(() => proc.emit("error", new Error("not found")));

    const model = await evaluateClaudeModel("- Do something");
    expect(model).toBe("sonnet");
  });
});
