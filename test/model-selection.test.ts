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

const { evaluateClaudeModel } = await import("../src/model-selection.js");

describe("evaluateClaudeModel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("returns model from CLI evaluation", async () => {
    mockSpawn("opus\n");
    const model = await evaluateClaudeModel("- Redesign the API architecture");
    expect(model).toBe("opus");
  });

  test("passes task to claude with opus model", async () => {
    mockSpawn("sonnet\n");
    await evaluateClaudeModel("- Add user auth");

    expect(child_process.spawn).toHaveBeenCalledWith(
      "claude",
      expect.arrayContaining(["--model", "opus", "--effort", "high", "-p"]),
      expect.any(Object),
    );
  });

  test("trims and lowercases the response", async () => {
    mockSpawn("  Haiku  \n");
    const model = await evaluateClaudeModel("- Fix typo in readme");
    expect(model).toBe("haiku");
  });

  test("falls back to sonnet on invalid model response", async () => {
    mockSpawn("gpt-4\n");
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
