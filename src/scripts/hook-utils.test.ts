import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { describe, expect, test } from "vitest";
import { writeStatus } from "./hook-utils.mjs";

describe("writeStatus", () => {
  test("preserves existing interactive metadata", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "workers-hook-utils-"));
    const statusFile = path.join(directory, "status.json");

    writeFileSync(
      statusFile,
      JSON.stringify({
        status: "running",
        source: "workers",
        launcherPid: 11111,
        childPid: 22222,
        startedAt: "2026-03-19T00:00:00.000Z",
      }) + "\n",
      "utf8",
    );

    writeStatus(statusFile, { status: "continue" });

    const status = JSON.parse(readFileSync(statusFile, "utf8")) as {
      status: string;
      launcherPid: number;
      childPid: number;
      startedAt: string;
    };

    expect(status.status).toBe("continue");
    expect(status.launcherPid).toBe(11111);
    expect(status.childPid).toBe(22222);
    expect(status.startedAt).toBe("2026-03-19T00:00:00.000Z");
  });
});
