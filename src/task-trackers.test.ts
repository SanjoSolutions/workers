import { mkdtempSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ClaimedTask } from "./task-trackers.js";

const ghCommands: string[] = [];
const ghResults: Array<{ exitCode: number; stdout: string }> = [];

vi.mock("zx", () => ({
  $: (strings: TemplateStringsArray, ...values: unknown[]) => {
    let command = "";
    for (const [index, chunk] of strings.entries()) {
      command += chunk;
      if (index < values.length) {
        command += String(values[index]);
      }
    }

    ghCommands.push(command.replace(/\s+/g, " ").trim());

    return {
      quiet() {
        return this;
      },
      async nothrow() {
        return ghResults.shift() ?? { exitCode: 0, stdout: "" };
      },
    };
  },
}));

const { syncCompletedTask } = await import("./task-trackers.js");

describe("syncCompletedTask", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "workers-task-trackers-"));
    ghCommands.length = 0;
    ghResults.length = 0;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("removes GitHub queue labels before closing a completed issue", async () => {
    const localTodoPath = path.join(tempDir, "TODO.md");
    writeFileSync(localTodoPath, "# TODOs\n\n## In progress\n\n## Ready to be picked up\n", "utf8");

    const claimedTask: ClaimedTask = {
      trackerName: "demo",
      trackerKind: "github-issues",
      trackerBasePath: tempDir,
      item: "- Ship the change",
      itemType: "unknown",
      itemAgent: "codex",
      summary: "Ship the change",
      localTodoContent: "",
      syncState: {
        kind: "github-issues",
        repository: "acme/widgets",
        issueNumber: 42,
        labels: {
          planned: "workers:planned",
          ready: "workers:ready-to-be-picked-up",
          inProgress: "workers:in-progress",
        },
      },
    };

    ghResults.push(
      {
        exitCode: 0,
        stdout: JSON.stringify({
          labels: [
            { name: "workers:ready-to-be-picked-up" },
            { name: "workers:in-progress" },
          ],
        }),
      },
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: "" },
    );

    const result = await syncCompletedTask(claimedTask, localTodoPath);

    expect(result).toEqual({ status: "synced" });
    expect(ghCommands).toEqual([
      "gh issue view 42 --repo acme/widgets --json labels",
      "gh issue edit 42 --repo acme/widgets --remove-label workers:ready-to-be-picked-up",
      "gh issue edit 42 --repo acme/widgets --remove-label workers:in-progress",
      "gh issue close 42 --repo acme/widgets --reason completed",
    ]);
  });
});
