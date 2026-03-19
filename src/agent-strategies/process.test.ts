import { EventEmitter } from "events";
import { afterEach, describe, expect, test, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("child_process", () => ({
  spawn: spawnMock,
}));

import { spawnAgentProcess } from "./process.js";

function createMockChildProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter | null;
    stderr: EventEmitter | null;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

describe("spawnAgentProcess", () => {
  afterEach(() => {
    spawnMock.mockReset();
    vi.restoreAllMocks();
  });

  test("uses the Windows shell for CLI commands", async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValueOnce(child);
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    const resultPromise = spawnAgentProcess({
      command: "claude",
      args: ["--help"],
      cwd: process.cwd(),
      env: process.env,
      captureOutput: false,
    });

    child.emit("close", 0);

    await expect(resultPromise).resolves.toEqual({
      exitCode: 0,
      output: "",
    });
    expect(spawnMock).toHaveBeenCalledWith(
      "claude",
      ["--help"],
      expect.objectContaining({
        shell: true,
      }),
    );
  });
});
